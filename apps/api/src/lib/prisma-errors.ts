type PrismaLikeError = {
  code?: unknown;
};

export function isPrismaErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as PrismaLikeError).code === code
  );
}
