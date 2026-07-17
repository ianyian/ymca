// Global, application-wide roles. Backed by the `AppRole` lookup table so new
// roles can be added as data. These constants mirror the seeded rows and give
// type-safety + fast in-process checks without a DB round-trip on every request.

export const APP_ROLE_ADMIN = "admin" as const;
export const APP_ROLE_USER = "user" as const;

// Seeded ids are stable (see the CoMa migration). Kept here for reference/tests.
export const APP_ROLE_IDS = {
  admin: 1,
  user: 2,
} as const;

export type AppRoleKey = string;

/** True when the role key grants administrator privileges (CoMa access). */
export function isAdminRole(key: string | null | undefined): boolean {
  return key === APP_ROLE_ADMIN;
}
