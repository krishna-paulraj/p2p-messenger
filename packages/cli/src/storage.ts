import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type Direction = "in" | "out";

export type StoredMessage = {
  id: number;
  ts: number;
  peer: string;
  direction: Direction;
  text: string;
};

export class MessageStore {
  private db: Database.Database;
  private insertStmt: Database.Statement;
  private recentStmt: Database.Statement;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        peer TEXT NOT NULL,
        direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
        text TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_messages_peer_ts ON messages (peer, ts);
    `);
    this.insertStmt = this.db.prepare(
      "INSERT INTO messages (ts, peer, direction, text) VALUES (?, ?, ?, ?)",
    );
    this.recentStmt = this.db.prepare(
      "SELECT * FROM (SELECT * FROM messages WHERE peer = ? ORDER BY ts DESC LIMIT ?) ORDER BY ts ASC",
    );
  }

  save(peer: string, direction: Direction, text: string): void {
    this.insertStmt.run(Date.now(), peer, direction, text);
  }

  recent(peer: string, limit = 20): StoredMessage[] {
    return this.recentStmt.all(peer, limit) as StoredMessage[];
  }

  close(): void {
    this.db.close();
  }
}
