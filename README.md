# Distributed Wagering Processor

Serviço financeiro distribuído que processa transações de apostas (`BET → WIN | LOSS | REFUND | ROLLBACK`)
vindas de múltiplos provedores, via **HTTP** e **AWS SQS**, com entrega *at-least-once*, múltiplas instâncias e
precisão monetária. Stack: **Bun · TypeScript strict · NestJS · MikroORM · PostgreSQL · SQS (LocalStack) · Docker Compose**.

> As decisões, trade-offs e limitações estão em [`ARCHITECTURE.md`](./ARCHITECTURE.md).

## Requisitos

- [Bun](https://bun.sh) 1.x
- Docker + Docker Compose (PostgreSQL e LocalStack)

## Subir tudo (3 instâncias + Postgres + LocalStack)

```bash
docker compose up --build
# instâncias: http://localhost:3001  :3002  :3003   (mesmo banco, mesma fila)
# o serviço `migrate` aplica as migrations antes das instâncias subirem
```

## Desenvolvimento local

```bash
bun install
docker compose up -d postgres localstack     # só a infraestrutura
cp .env.example .env
bun run migrate                              # aplica migrations (reversíveis: bun run migrate:down)
bun run start:dev                            # http://localhost:3000
```

Cada instância executa, conforme flags de ambiente, o **consumidor SQS**, o **publicador da outbox** e o
**worker de referências pendentes** (`ENABLE_SQS_CONSUMER`, `ENABLE_OUTBOX_PUBLISHER`, `ENABLE_PENDING_REFERENCE_WORKER`).
Todos são seguros com N instâncias simultâneas.

## Comandos

| Comando | O que faz |
|---|---|
| `bun run typecheck` | `tsc --noEmit` (strict) |
| `bun test tests/unit` (`bun run test`) | testes de unidade (domínio puro, sem I/O) |
| `bun run test:infra:up` | sobe PostgreSQL + LocalStack para os testes (`docker-compose.test.yml`) |
| `bun run test:integration` | PostgreSQL e SQS reais: constraints, atomicidade, inbox/outbox, DLQ, crash recovery |
| `bun run test:concurrency` | paralelismo real: 50× mesma aposta, disputa de saldo, **3 processos**, kill -9, SIGTERM |
| `bun run test:all` | tudo |
| `bun run test:db:reset` | recria o schema do banco apontado por `DATABASE_URL` (migrate down + up) |
| `bun run test:load` | teste de carga (ver abaixo) |
| `bun run test:infra:down` | derruba a infra de testes |

```bash
bun run test:infra:up
export REQUIRE_SQS=1        # falha (em vez de pular) se não houver broker SQS
bun run test:all
```

Variáveis dos testes: `TEST_DATABASE_URL` (default `postgresql://postgres:postgres@localhost:5432/wagering_test`) e
`TEST_AWS_ENDPOINT_URL` (default `http://localhost:4566`). Os testes usam ids únicos por execução, então não precisam
limpar tabelas (o ledger é append-only e não aceita `TRUNCATE`); use `test:db:reset` se quiser um banco zerado.

### Teste de carga

```bash
docker compose up -d --build
WALLETS=200 CONCURRENCY=64 DURATION_S=30 bun run test:load
```

Gera carga mista (BET 50 / WIN 25 / LOSS 15 / REFUND 10) com *skew* para carteiras quentes, distribuída entre as 3
instâncias; ao final reconcilia **todas** as carteiras pela API (falha se alguma divergir) e grava
`tests/load/results/<runId>.json` com ambiente, metodologia, throughput, p50/p95/p99, taxa de erro, conflitos de
concorrência e *outbox lag*.

## API

Todas as respostas de erro seguem `{ "error": { "code", "message", "retryable", "details?" }, "correlationId" }`.

| Método | Rota | Descrição |
|---|---|---|
| `POST` | `/wallets` | cria wallet (`201`); duplicada `(playerId, currency)` → `409` |
| `GET` | `/wallets/:walletId` | saldo e versão |
| `GET` | `/wallets/:walletId/ledger?cursor=&limit=50` | extrato paginado (cursor opaco e estável) |
| `POST` | `/wallets/:walletId/reconciliation` | compara saldo materializado × saldo reconstruído do ledger |
| `POST` | `/wagering/transactions` | submete transação (header `Idempotency-Key` obrigatório) |
| `GET` | `/wagering/transactions/:transactionId` | consulta por id interno |
| `GET` | `/providers/:providerId/wagering/transactions/:externalTransactionId` | consulta pelo id do provedor |
| `GET` | `/health/live` · `/health/ready` | liveness · readiness (PostgreSQL + SQS) — sem autenticação |
| `GET` | `/metrics` | Prometheus |

### Mapeamento de status HTTP

| Situação | HTTP | `retryable` |
|---|---|---|
| processada (inclusive replay idempotente, `idempotentReplay: true`) | `200` | — |
| aceita, aguardando a transação referenciada (`PENDING_REFERENCE`) | `202` | — |
| payload inválido / header ausente / `OPENING` / dinheiro inválido | `400` | não |
| wallet ou transação inexistente | `404` | não |
| conflito de idempotência (mesma key, payload diferente; mesmo `externalTransactionId` com outra key) / wallet duplicada | `409` | não |
| rejeição por regra de negócio (`REJECTED` + `failureCode`) | `422` | não — ver `failureCode` |
| falha transitória de infraestrutura (PostgreSQL/SQS/timeout/lock) | `503` + `Retry-After` | **sim** |
| erro inesperado | `500` | não |

### Exemplo

```bash
curl -s -XPOST localhost:3001/wallets -H 'content-type: application/json' \
  -d '{"playerId":"player-1","initialBalance":{"amount":"1000.00","currency":"BRL"}}'

curl -s -XPOST localhost:3001/wagering/transactions -H 'content-type: application/json' \
  -H 'Idempotency-Key: provider-a:transaction-123' \
  -d '{"providerId":"provider-a","externalTransactionId":"transaction-123","playerId":"player-1",
       "walletId":"<id>","roundId":"round-987","gameId":"fortune-chimp","kind":"BET",
       "money":{"amount":"25.00","currency":"BRL"}}'
```

### Fila (SQS)

`wager-transactions.fifo` (DLQ: `wager-transactions-dlq.fifo`; eventos de saída: `wager-events.fifo`, `MessageGroupId = walletId`).
Corpo da mensagem: ver enunciado (`WagerTransactionRequested`, com `messageId` e `data.idempotencyKey`).
O consumidor usa **o mesmo caso de uso** da API HTTP.

## Estrutura

```
src/
  domain/          Money, Wallet, WagerTransaction, WalletLedgerEntry, Inbox/Outbox, eventos, settlement (sem I/O)
  application/     casos de uso + portas (repositórios, TransactionRunner, EventPublisher, Metrics…)
  infrastructure/  MikroORM (records, repositórios, migrations), SQS (consumer/publisher), workers, logger, métricas
  http/            controllers, filtro de erros, ponto de extensão de autenticação
tests/             unit · integration · concurrency · load · support
```
