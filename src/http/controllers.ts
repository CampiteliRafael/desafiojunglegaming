import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { LoggerPort, MetricsPort, TOKENS } from '../application/ports/ports';
import { httpSubmissionSchema, moneySchema, parseZod, toBusinessFields } from '../application/submission-schema';
import { CreateWalletUseCase } from '../application/use-cases/create-wallet';
import { ReconcileWalletUseCase } from '../application/use-cases/reconcile-wallet';
import { TransactionQueries, WalletQueries } from '../application/use-cases/queries';
import {
  SubmitWagerTransactionResult,
  SubmitWagerTransactionUseCase,
} from '../application/use-cases/submit-wager-transaction';
import { ValidationError } from '../domain/errors';
import { WagerTransactionStatus } from '../domain/wager-transaction';
import { RequestContext } from '../infrastructure/observability/request-context';
import { PrometheusMetrics } from '../infrastructure/observability/metrics';
import { SqsQueues } from '../infrastructure/sqs/sqs-queues';
import { MikroORM } from '@mikro-orm/postgresql';
import { ApiAuthGuard } from './auth';

const uuid = z.uuid();
const createWalletSchema = z.object({ playerId: z.string().min(1).max(128), initialBalance: moneySchema }).strict();

function pathUuid(value: string, name: string): string {
  if (!uuid.safeParse(value).success) throw new ValidationError(`${name} must be a UUID`);
  return value;
}

const correlationId = (): string => RequestContext.get().correlationId ?? 'unknown';

// ------------------------------------------------------------------------------------------ wallets
@Controller('wallets')
@UseGuards(ApiAuthGuard)
export class WalletsController {
  constructor(
    @Inject(CreateWalletUseCase) private readonly createWallet: CreateWalletUseCase,
    @Inject(WalletQueries) private readonly queries: WalletQueries,
    @Inject(ReconcileWalletUseCase) private readonly reconcile: ReconcileWalletUseCase,
  ) {}

  @Post()
  @HttpCode(201)
  async create(@Body() body: unknown) {
    const input = parseZod(createWalletSchema, body);
    return this.createWallet.execute({ ...input, correlationId: correlationId() });
  }

  @Get(':walletId')
  get(@Param('walletId') walletId: string) {
    return this.queries.getWallet(pathUuid(walletId, 'walletId'));
  }

  @Get(':walletId/ledger')
  ledger(@Param('walletId') walletId: string, @Query('cursor') cursor?: string, @Query('limit') limit?: string) {
    const parsedLimit = limit === undefined ? 50 : Number(limit);
    if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 200) {
      throw new ValidationError('limit must be an integer between 1 and 200');
    }
    return this.queries.listLedger(pathUuid(walletId, 'walletId'), cursor || undefined, parsedLimit);
  }

  @Post(':walletId/reconciliation')
  @HttpCode(200)
  reconciliation(@Param('walletId') walletId: string) {
    return this.reconcile.execute(pathUuid(walletId, 'walletId'), correlationId());
  }
}

// ------------------------------------------------------------------------------------------ wagering
function submitResponse(r: SubmitWagerTransactionResult, res: Response) {
  const body = {
    transactionId: r.transactionId,
    status: r.status,
    balance: r.balance.toJSON(),
    ...(r.failureCode ? { failureCode: r.failureCode } : {}),
    idempotentReplay: r.idempotentReplay,
  };
  switch (r.status) {
    case WagerTransactionStatus.Processed:
      res.status(200);
      break;
    case WagerTransactionStatus.Rejected:
      res.status(422); // business rule violation: final, see failureCode
      break;
    case WagerTransactionStatus.Failed:
      res.status(500);
      break;
    default:
      res.status(202); // accepted, waiting for its reference
  }
  return body;
}

@Controller()
@UseGuards(ApiAuthGuard)
export class WageringController {
  constructor(
    @Inject(SubmitWagerTransactionUseCase) private readonly submit: SubmitWagerTransactionUseCase,
    @Inject(TransactionQueries) private readonly queries: TransactionQueries,
  ) {}

  @Post('wagering/transactions')
  async submitTransaction(
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (!idempotencyKey || idempotencyKey.length > 256) {
      throw new ValidationError('Idempotency-Key header is required (1..256 chars)', [
        { path: 'Idempotency-Key', message: 'missing or too long' },
      ]);
    }
    const fields = toBusinessFields(parseZod(httpSubmissionSchema, body));
    const result = await this.submit.execute({
      idempotencyKey,
      fields,
      correlationId: correlationId(),
      source: { type: 'http' },
    });
    RequestContext.set({ transactionId: result.transactionId, walletId: fields.walletId, providerId: fields.providerId });
    return submitResponse(result, res);
  }

  @Get('wagering/transactions/:transactionId')
  getById(@Param('transactionId') transactionId: string) {
    return this.queries.getById(pathUuid(transactionId, 'transactionId'));
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  getByExternal(@Param('providerId') providerId: string, @Param('externalTransactionId') externalTransactionId: string) {
    return this.queries.getByProviderExternalId(providerId, externalTransactionId);
  }
}

// ------------------------------------------------------------------------------------------ health (no auth)
@Controller('health')
export class HealthController {
  constructor(
    @Inject(MikroORM) private readonly orm: MikroORM,
    @Inject(SqsQueues) private readonly sqs: SqsQueues,
    @Inject(TOKENS.Logger) private readonly logger: LoggerPort,
  ) {}

  @Get('live')
  live() {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready(@Res({ passthrough: true }) res: Response) {
    const timeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
      Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
    const check = async (name: string, fn: () => Promise<unknown>) => {
      try {
        await timeout(fn(), 2000);
        return { name, ok: true };
      } catch (e) {
        this.logger.warn('readiness check failed', { dependency: name, error: e instanceof Error ? e.message : String(e) });
        return { name, ok: false };
      }
    };
    const results = await Promise.all([
      check('postgres', () => this.orm.em.getConnection().execute('SELECT 1')),
      check('sqs', () => this.sqs.ping()),
    ]);
    const body = { status: results.every((r) => r.ok) ? 'ok' : 'unavailable', checks: Object.fromEntries(results.map((r) => [r.name, r.ok ? 'up' : 'down'])) };
    if (body.status !== 'ok') res.status(503); // not ready: orchestrator stops routing traffic, liveness stays green
    return body;
  }
}

// ------------------------------------------------------------------------------------------ metrics
@Controller('metrics')
export class MetricsController {
  constructor(@Inject(TOKENS.Metrics) private readonly metrics: MetricsPort) {}

  @Get()
  @Header('Content-Type', 'text/plain; version=0.0.4')
  async scrape(): Promise<string> {
    return (this.metrics as PrometheusMetrics).registry.metrics();
  }
}
