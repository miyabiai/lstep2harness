import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalD1 } from "../src/d1/local.js";
import { createTestDatabase } from "../src/init-db.js";

const DIRECTORIES: string[] = [];
afterEach(() => { for (const directory of DIRECTORIES.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe("init-db", () => {
  it("creates a private L Harness-shaped database with one inactive target account", () => {
    const directory = mkdtempSync(join(tmpdir(), "lstep-init-db-"));
    DIRECTORIES.push(directory);
    const dbPath = join(directory, "nested", "test.sqlite");
    createTestDatabase(dbPath, "trial-account");
    expect(statSync(dbPath).mode & 0o777).toBe(0o600);
    const database = new LocalD1(dbPath);
    try {
      expect(database.all("SELECT id,is_active,channel_access_token FROM line_accounts"))
        .toEqual([{ id: "trial-account", is_active: 0, channel_access_token: "not-a-live-token" }]);
      expect(database.count("friends")).toBe(0);
    } finally {
      database.close();
    }
  });

  it("never overwrites an existing database", () => {
    const directory = mkdtempSync(join(tmpdir(), "lstep-init-db-"));
    DIRECTORIES.push(directory);
    const dbPath = join(directory, "test.sqlite");
    createTestDatabase(dbPath, "trial-account");
    expect(() => createTestDatabase(dbPath, "other")).toThrow("既にあります");
  });

  it("leaves the permissions of an existing folder unchanged", () => {
    const directory = mkdtempSync(join(tmpdir(), "lstep-init-db-"));
    DIRECTORIES.push(directory);
    chmodSync(directory, 0o755);
    createTestDatabase(join(directory, "test.sqlite"), "trial-account");
    expect(statSync(directory).mode & 0o777).toBe(0o755);
  });
});
