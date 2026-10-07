import { EventContext } from '../domain/events/integration-event';
import { newId } from '../shared/ids';

/** Every event gets its own eventId; correlation/causation are shared by the whole command. */
export type EventContextFactory = () => EventContext;

export function eventContextFactory(params: {
  correlationId: string;
  causationId?: string | undefined;
  now: Date;
}): EventContextFactory {
  return () => ({
    eventId: newId(),
    correlationId: params.correlationId,
    causationId: params.causationId,
    occurredAt: params.now,
  });
}
