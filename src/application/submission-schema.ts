import { z } from 'zod';
import { ValidationError } from '../domain/errors';
import { Money } from '../domain/money';
import { BusinessFields, SUBMITTABLE_KINDS, WagerTransactionKind } from '../domain/wager-transaction';

const id = (max = 128) => z.string().min(1).max(max);

export const moneySchema = z.object({ amount: z.string(), currency: z.string() }).strict();

/** Business payload shared by the HTTP body and the SQS message `data`. Unknown keys are rejected. */
export const submissionFields = {
  providerId: id(),
  externalTransactionId: id(),
  playerId: id(),
  walletId: z.uuid(),
  roundId: id(),
  gameId: id(),
  kind: z.string(),
  money: moneySchema,
  referenceExternalTransactionId: id().optional(),
};

export const httpSubmissionSchema = z.object(submissionFields).strict();
export const queueSubmissionSchema = z.object({ ...submissionFields, idempotencyKey: id(256) }).strict();

type RawSubmission = z.infer<typeof httpSubmissionSchema>;

/** Converts validated-but-raw input to domain types. Throws ValidationError on any violation. */
export function toBusinessFields(raw: RawSubmission): BusinessFields {
  if (raw.kind === WagerTransactionKind.Opening) {
    throw new ValidationError('OPENING is an internal transaction and cannot be submitted');
  }
  if (!SUBMITTABLE_KINDS.includes(raw.kind as WagerTransactionKind)) {
    throw new ValidationError(`unsupported kind "${raw.kind}"`);
  }
  let money: Money;
  try {
    money = Money.from(raw.money);
  } catch (e) {
    throw new ValidationError(e instanceof Error ? e.message : 'invalid money');
  }
  return {
    providerId: raw.providerId,
    externalTransactionId: raw.externalTransactionId,
    playerId: raw.playerId,
    walletId: raw.walletId,
    roundId: raw.roundId,
    gameId: raw.gameId,
    kind: raw.kind as WagerTransactionKind,
    money,
    referenceExternalTransactionId: raw.referenceExternalTransactionId,
  };
}

export function parseZod<T>(schema: z.ZodType<T>, input: unknown): T {
  const r = schema.safeParse(input);
  if (!r.success) {
    throw new ValidationError(
      'invalid payload',
      r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  return r.data;
}
