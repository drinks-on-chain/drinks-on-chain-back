/** Un registro cuenta como tardío si se anotó más de 7 días después del hecho (S-9). */
export const LATE_ENTRY_DAYS = 7;

export function isLateEntry(occurredAt: Date, recordedAt: Date): boolean {
  return (
    recordedAt.getTime() - occurredAt.getTime() > LATE_ENTRY_DAYS * 86_400_000
  );
}
