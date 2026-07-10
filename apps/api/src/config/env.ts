import { config as loadDotEnv } from "dotenv";
import { z } from "zod";

loadDotEnv();

const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  API_HOST: z.string().default("0.0.0.0"),
  API_PORT: z.coerce
    .number()
    .int()
    .positive()
    .default(Number(process.env.PORT ?? 4000)),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  BCRYPT_ROUNDS: z.coerce.number().int().min(10).max(15).default(12),
  SESSION_TTL_DAYS: z.coerce.number().int().positive().default(30),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.string().default("noreply@ymca.local"),
  APP_URL: z.string().default("http://localhost:5173"),
});

export type AppEnv = z.infer<typeof envSchema>;

export function getEnv(): AppEnv {
  return envSchema.parse(process.env);
}
