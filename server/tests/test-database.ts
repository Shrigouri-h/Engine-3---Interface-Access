/**
 * The automated tests never touch the demo database: global-setup drops and
 * recreates `goldenhour_test`, migrates it, then seeds the same Gate 2 demo data.
 */
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgresql://goldenhour:goldenhour@localhost:5432/goldenhour_test';

export const ADMIN_DATABASE_URL =
  process.env.TEST_ADMIN_DATABASE_URL ??
  'postgresql://goldenhour:goldenhour@localhost:5432/postgres';
