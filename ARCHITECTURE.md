# ARCHITECTURE

## 1. Visão geral

```
 HTTP  ─┐                                   ┌────────────── PostgreSQL (uma transação SQL) ──────────────┐
        ├─► SubmitWagerTransactionUseCase ─►│ inbox · wager_transactions · wallets · ledger · outbox      │
 SQS  ──┘   (mesmo caso de uso)             └──────────────┬──────────────────────────────────────────────┘
                                                           │ commit
        OutboxPublisherWorker (N instâncias, SKIP LOCKED) ◄┘──► SQS wager-events.fifo
        PendingReferenceWorker (N instâncias)  ─► reavalia PENDING_REFERENCE (backoff exponencial)
```

Camadas (dependências apontam para dentro): `domain` (puro, sem ORM/Nest) ← `application` (casos de uso e portas) ←
`infrastructure`/`http` (adapters). O domínio tem construtores privados + factories (`create`/`from`/`rehydrate`);
`rehydrate` reconstrói estado sem revalidar transições.

## 2. Decisões de dinheiro (`Money`)

- Nunca `number`/`float`. Internamente é `bigint` em **centavos** (escala 2): toda operação é aritmética inteira exata.
- Entrada estrita: `^(0|[1-9]\d{0,15})\.\d{2}$` — exatamente 2 casas, sem sinal, expoente, `NaN`, `Infinity` ou vazio.
- Serializado sempre como string decimal (`"25.00"`). Eventos carregam `MoneyProps`, nunca a instância.
- Persistência: `numeric(20,2)` + `char(3)` em colunas separadas; o driver devolve `string` (sem passar por `number`) e a
  reidratação usa `Money.fromPersisted`. Moedas diferentes lançam `CurrencyMismatchError`; o modelo é multi-moeda
  (testes cobrem o conflito), com BRL como moeda dos exemplos.

## 3. ORM: MikroORM (Data Mapper)

Escolhido por ter `EntityManager.transactional()`, `LockMode` e Unit of Work/Identity Map explícitos. Como as classes de
domínio têm construtor privado e estado encapsulado, **não são mapeadas pelo ORM**: o mapeamento é feito com
`EntitySchema` sobre *records* planos (`infrastructure/persistence/entities`), e repositórios convertem
record ⇄ agregado. Assim o domínio não depende de decorators nem tipos do ORM.

Estratégia transacional: cada caso de uso roda em `TransactionRunner.run()` = **um fork do EntityManager = uma transação
SQL**. Leituras usam `refresh: true` — o identity map nunca devolve um snapshot lido *antes* de o lock ser concedido (esse
bug apareceu nos testes de reprocessamento concorrente e está coberto). Os `INSERT`/`UPDATE` são explícitos
(`em.insert`/`nativeUpdate`) para controlar ordem de FKs e usar `ON CONFLICT`/`SKIP LOCKED` onde necessário; o UoW
de escrita automático não é usado de propósito. Migrations: MikroORM `Migrator`, lista explícita, `up()`/`down()`.

## 4. Concorrência

Unidade de concorrência = **`walletId`**.

1. `SELECT … FOR UPDATE` na linha da wallet (`LockMode.PESSIMISTIC_WRITE`): serializa todos os escritores *daquela*
   wallet, em qualquer instância; wallets diferentes nunca disputam lock (sem lock global — teste dedicado).
2. Defesa em profundidade: `UPDATE wallets … WHERE id = ? AND version = ?` (optimistic guard) e um trigger que só admite
   alteração de `balance` junto com `version + 1`.
3. `lock_timeout` (5 s) e `statement_timeout` por transação; timeout/deadlock/`40001` são conflitos **transitórios**:
   o caso de uso refaz a unidade de trabalho até 4× com backoff + jitter e conta `wager_lock_conflicts_total`.

Por que pessimista: wallet quente tem contenção alta e a operação é curta; otimista geraria tempestade de retries.
Custo: throughput de uma wallet é limitado pela latência de uma transação (serial); wallets distintas escalam.

## 5. Idempotência (persistente)

- Fonte da verdade: header `Idempotency-Key` (HTTP) / `data.idempotencyKey` (SQS). Nada em memória.
- `payloadHash` = **SHA-256** do JSON canônico (chaves ordenadas) de `{externalTransactionId, gameId, kind, money{amount,currency},
  playerId, providerId, referenceExternalTransactionId?, roundId, walletId}`. Header, `messageId`, `occurredAt` e a própria key
  ficam fora.
- Fluxo: lookup por key (caminho rápido) → trava a wallet → **relê sob o lock** → decide e grava. Constraints
  `UNIQUE(idempotency_key)` e `UNIQUE(provider_id, external_transaction_id)` são o árbitro final; quem perde a corrida
  recebe `23505`, o caso de uso refaz e cai no replay/conflito.
- Mesma key + mesmo hash → replay com o **resultado original** (inclusive o saldo observado na época:
  `wager_transactions.observed_balance`). Mesma key + hash diferente → `409`. Mesmo `externalTransactionId` com outra key → `409`
  (reaplicaria dinheiro).

## 6. Máquina de estados da transação

```
PENDING ──► PROCESSED | REJECTED | PENDING_REFERENCE | FAILED
PENDING_REFERENCE ──► PROCESSED | REJECTED | PENDING_REFERENCE (nova tentativa) | FAILED
PROCESSED, REJECTED, FAILED = terminais (sem transições)
```
Transicionar um terminal é erro de programação (`InvalidTransactionStateError`) **e** o banco recusa (trigger).
`FAILED` é reservado a erro permanente de infraestrutura (`markFailed`, auditável); regras de negócio sempre resultam em `REJECTED`.

### Interpretações adotadas

- Uma referência só pode ser revertida **uma vez por qualquer** `REFUND`/`ROLLBACK` (mais estrito que “uma vez por tipo”:
  evita BET reembolsada *e* revertida = crédito duplo). Garantido por índice único parcial.
- `WIN`/`LOSS` podem referenciar uma `BET` (opcional); se declarada e ainda inexistente, aguarda como `REFUND`/`ROLLBACK`.
- `LOSS` aceita valor `0.00`; os demais exigem valor positivo.
- `ROLLBACK` credita se a referência foi `BET`; debita se `WIN` ou `REFUND`. `ROLLBACK` de `LOSS` → `REFERENCE_INVALID_KIND`.
- Referência `PENDING`/`PENDING_REFERENCE` ⇒ a transação também espera; `REJECTED`/`FAILED` ⇒ `REFERENCE_NOT_PROCESSED`.
- Wallet inexistente não vira transação (não há FK possível): `404` na API, DLQ na fila.
- `OPENING` (crédito de abertura) usa provider reservado `internal`; API e fila o rejeitam (e há `CHECK` no banco).

### Taxonomia de `failureCode` (e orientação ao provedor)

| Código | Quando | Orientação |
|---|---|---|
| `INSUFFICIENT_FUNDS` | BET acima do saldo | sem retry |
| `REVERSAL_INSUFFICIENT_FUNDS` | REFUND/ROLLBACK deixaria saldo < 0 (**distinto** do anterior) | sem retry; operação manual |
| `CURRENCY_MISMATCH` | moeda ≠ moeda da wallet | corrigir e reenviar |
| `WALLET_PLAYER_MISMATCH` | `playerId` não é dono da wallet | corrigir e reenviar |
| `REFERENCE_NOT_FOUND` | referência não chegou (tentativas/TTL esgotados) | corrigir e reenviar |
| `REFERENCE_MISMATCH` | referência de outro provider/player/wallet/moeda/rodada | corrigir e reenviar |
| `REFERENCE_INVALID_KIND` | tipo não permitido (REFUND de WIN, ROLLBACK de LOSS…) | corrigir e reenviar |
| `REFERENCE_NOT_PROCESSED` | referência rejeitada/falha | sem retry |
| `REFERENCE_ALREADY_REVERSED` | referência já revertida | sem retry |
| `REFERENCE_AMOUNT_MISMATCH` | valor ≠ valor da referência (parcial fora de escopo) | corrigir e reenviar |
| `INTERNAL_PERMANENT_ERROR` | `FAILED` | contatar suporte |

## 7. Garantias aplicadas **no schema** (migration `…initial_schema`)

| Garantia | Mecanismo |
|---|---|
| uma wallet por `(player_id, currency)` | `UNIQUE` |
| saldo ≥ 0 | `CHECK (balance >= 0)` |
| `version` só sobe com mudança de saldo | trigger `fn_wallet_guard` (BEFORE UPDATE) |
| idempotência / `(provider, externalId)` únicos | `UNIQUE` |
| `OPENING` só interno | `CHECK ((kind='OPENING') = (provider_id='internal'))` |
| REFUND/ROLLBACK exigem referência; `failure_code` ⇔ REJECTED/FAILED | `CHECK` |
| terminais imutáveis, campos de negócio imutáveis, sem `DELETE` | trigger `fn_wager_tx_guard` |
| uma reversão por referência | índice único parcial `uq_wager_tx_single_reversal` |
| ledger **append-only** (sem UPDATE/DELETE/TRUNCATE) | triggers `BEFORE UPDATE OR DELETE` + `BEFORE TRUNCATE` |
| aritmética de cada lançamento; valor > 0; saldos ≥ 0 | `CHECK ck_ledger_balanced` |
| ≤ 1 lançamento por wallet por transação | `UNIQUE (wallet_id, transaction_id)` |
| **saldo da wallet = `balance_after` do último lançamento** (e vice-versa) | *constraint triggers* **deferred** (checados no COMMIT) |
| transação `PROCESSED` com efeito no saldo ⇔ tem lançamento (REJECTED/PENDING nunca têm) | *constraint trigger* deferred |
| inbox único por `(consumer_name, message_id)` | PK |
| conteúdo do evento da outbox imutável | trigger |

O par de *constraint triggers* torna “toda alteração de saldo tem lançamento (e vice-versa)” uma propriedade do banco,
não só do código (testado forçando o commit sem o lançamento).

## 8. SQS: inbox, retry, DLQ, shutdown

- `ack` (`DeleteMessage`) **somente depois do commit**. A linha de **inbox** `(consumerName, messageId)` entra na *mesma*
  transação SQL do efeito financeiro, então “worker morreu depois do commit e antes do ack” → redelivery cai no inbox e
  devolve o resultado original, sem novo débito (testado com o broker real).
- Classificação: desfecho de negócio (`PROCESSED`/`REJECTED`/`PENDING_REFERENCE`/replay) → **ack**;
  erro de domínio permanente (JSON inválido, dinheiro inválido, wallet inexistente, conflito de idempotência) → **DLQ**
  (mensagem original + `failureReason`, métrica `wager_dlq_messages_total`) e ack da principal; erro
  transitório/desconhecido → **não deleta** e ajusta a visibilidade com backoff exponencial; ao atingir
  `SQS_MAX_RECEIVE_COUNT` → DLQ (`retries_exhausted`). A fila principal tem também `RedrivePolicy` (rede de segurança do broker).
- FIFO: mensagens do mesmo `MessageGroupId` (= wallet) em ordem; grupos distintos em paralelo; após um retry o resto do
  grupo é devolvido (visibilidade 0). **A ordem do broker é otimização**: a consistência vem do banco.
- `SIGTERM`: para o polling (long-poll abortado), conclui as mensagens em andamento, devolve as ainda não iniciadas,
  espera até `SHUTDOWN_GRACE_MS` e fecha o pool; o processo sai com código 0.

## 9. Outbox transacional

- Eventos (`WagerTransactionProcessed`/`Rejected`/`PendingReference`, `WalletBalanceChanged` — só quando o saldo muda) são
  gravados na outbox **na mesma transação**; nada é publicado antes do commit. `eventId` = id da linha da outbox.
- Publisher: `SELECT … FOR UPDATE SKIP LOCKED` dentro de uma transação, `SendMessageBatch` para `wager-events.fifo`
  (`MessageGroupId = walletId`, `MessageDeduplicationId = eventId`), `published_at` e retries com backoff exponencial
  (`attempts`, `next_attempt_at`). N publishers nunca pegam as mesmas linhas.
- Crash entre “broker aceitou” e COMMIT: o lock é liberado, outra instância reenvia ⇒ **at-least-once**; o consumidor
  deduplica por `eventId` (e o FIFO deduplica por 5 min). Testado (duplicata realmente ocorre e é inócua).
- Referências fora de ordem: `PENDING_REFERENCE` com `next_reference_attempt_at`; worker agendado reavalia sob o lock da wallet,
  relendo o estado depois do lock (vários workers ⇒ aplicado uma vez). Limite: **8 tentativas ou 10 min** (o que vier primeiro;
  configurável) — janela suficiente para atrasos de entrega comuns sem manter dinheiro “em espera” indefinidamente. Esgotado ⇒
  `REJECTED/REFERENCE_NOT_FOUND` + evento.

## 10. Observabilidade

Logs JSON (uma linha) com `correlationId`, `messageId`, `transactionId`, `walletId`, `providerId` via `AsyncLocalStorage`;
campos financeiros (`money`, `amount`, `balance`, `payload`…) são **redigidos** pelo logger e o log de acesso nunca grava corpo.
Métricas (`/metrics`): `wager_transactions_total{status,kind}`, `wager_duplicates_detected_total`, `wager_retries_total`,
`wager_dlq_messages_total`, `wager_lock_conflicts_total`, `wager_outbox_lag_seconds`/`_pending`, `wager_outbox_published_total`,
`wager_processing_duration_seconds`, `wager_reconciliation_divergences_total`. Métricas são contadas **após o commit**.
Health: `/health/live` (processo) e `/health/ready` (PostgreSQL + SQS; `503` com detalhe por dependência).

## 11. Autenticação (decisão)

Não implementada, conforme permitido pelo enunciado. Ponto de extensão explícito: `ProviderIdentityPort` (`TOKENS.ProviderIdentity`)
+ `ApiAuthGuard` aplicado aos controllers de negócio (health e métricas ficam abertos); o adapter padrão é `NoopProviderIdentity`.
Desenho: Keycloak/Zitadel (OIDC, *client credentials* por provedor), guard valida o JWT contra o JWKS do IdP e mapeia
`azp`/`client_id` → `providerId`, rejeitando requests cujo `providerId` do corpo difira do autenticado. Mensagens da fila são
canal interno confiável, mas a identidade do provedor na mensagem continua sujeita às validações de domínio.

## 12. Testes

- **Unidade** (52): `Money`, `Wallet`, ledger, settlement (todas as regras de BET/WIN/LOSS/REFUND/ROLLBACK), máquina de estados, hash, outbox/inbox.
- **Integração** (PostgreSQL real; SQS real via LocalStack/MiniStack): constraints e triggers, atomicidade (rollback total e rejeição no COMMIT),
  API (status mapping, replay, conflito, paginação), referências fora de ordem, outbox (publishers concorrentes, crash antes do commit, backoff),
  consumidor SQS (duplicatas, crash depois do commit/antes do ack, DLQ, retry→DLQ, readiness).
- **Concorrência** (paralelismo real): 50× a mesma aposta; cenário obrigatório (100,00 / 2×80,00) repetido 25×; wallet quente (200 apostas, 3 processos);
  60 wallets em paralelo; REFUND×ROLLBACK simultâneos; lock segurado em uma wallet não bloqueia outra; **kill -9** no meio da carga + reinício + replay;
  SIGTERM. **Todo teste termina com** `wallet.balance == saldo reconstruído do ledger` (+ cadeia contínua, nada negativo).

## 13. Limitações e trade-offs conhecidos

- **Throughput por wallet quente** é serial (um lock por wallet). Escala com o número de wallets, não de instâncias, para uma única wallet.
- Os *constraint triggers* deferred adicionam 2–3 leituras indexadas por commit: custo consciente em troca de garantia no banco.
- A outbox publica **dentro** da transação de claim (segura o lock durante a chamada ao SQS; lotes pequenos e timeouts mitigam).
  Com múltiplos publishers a **ordem entre eventos da mesma wallet não é garantida** — consumidores devem usar `walletVersion` para ordenar.
- Reversão parcial fora de escopo; uma referência só é revertida uma vez (ver §6).
- `FAILED` existe e é auditável, mas hoje só é produzido por `markFailed` (não há fluxo automático de erro permanente após a criação da transação).
- Reprocessamento de referências é por *polling*; não há gatilho imediato quando a referência chega (latência ≤ intervalo do worker + backoff).
- Autenticação não implementada (ver §11). `down` da migration destrói dados (uso dev/test).
- Validação neste ambiente: PostgreSQL 16 real; o broker SQS usado na validação local foi o emulador *moto* (sem Docker disponível);
  `docker-compose*.yml` e o script de init do LocalStack não foram executados aqui.
