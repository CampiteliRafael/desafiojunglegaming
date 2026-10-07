/** UUID v7: time-ordered, index-friendly. Bun provides it natively. */
export const newId = (): string => Bun.randomUUIDv7();
