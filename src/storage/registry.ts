import { nanoid } from "nanoid";
import type { Db } from "./db";
import type { RegistryEntry, RegistryKind, ResourceType } from "../shared/schemas";

interface RegistryRow {
  id: string;
  host_id: string;
  kind: RegistryKind;
  adapter_id: string | null;
  resource_type: ResourceType;
  stable_key: string;
  label: string;
  custom_endpoint: string | null;
  managed: number;
  note: string | null;
  created_at: string;
  updated_at: string;
}

function toEntry(row: RegistryRow): RegistryEntry {
  return {
    id: row.id,
    hostId: row.host_id,
    kind: row.kind,
    adapterId: row.adapter_id ?? undefined,
    resourceType: row.resource_type,
    stableKey: row.stable_key,
    label: row.label,
    customEndpoint: row.custom_endpoint ?? undefined,
    managed: row.managed === 1,
    note: row.note ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export interface NewRegistryEntry {
  kind: RegistryKind;
  adapterId?: string;
  resourceType: ResourceType;
  stableKey: string;
  label: string;
  customEndpoint?: string;
  managed?: boolean;
  note?: string;
}

export class RegistryRepository {
  constructor(
    private readonly db: Db,
    private readonly hostId: string
  ) {}

  list(): RegistryEntry[] {
    const rows = this.db
      .prepare("SELECT * FROM registry_entries WHERE host_id = ? ORDER BY created_at")
      .all(this.hostId) as RegistryRow[];
    return rows.map(toEntry);
  }

  find(adapterId: string, resourceType: ResourceType, stableKey: string): RegistryEntry | undefined {
    const row = this.db
      .prepare(
        "SELECT * FROM registry_entries WHERE host_id = ? AND adapter_id = ? AND resource_type = ? AND stable_key = ? LIMIT 1"
      )
      .get(this.hostId, adapterId, resourceType, stableKey) as RegistryRow | undefined;
    return row ? toEntry(row) : undefined;
  }

  create(input: NewRegistryEntry): RegistryEntry {
    const now = new Date().toISOString();
    const id = `reg:${nanoid(10)}`;
    this.db
      .prepare(
        `INSERT INTO registry_entries
         (id, host_id, kind, adapter_id, resource_type, stable_key, label, custom_endpoint, managed, note, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        this.hostId,
        input.kind,
        input.adapterId ?? null,
        input.resourceType,
        input.stableKey,
        input.label,
        input.customEndpoint ?? null,
        input.managed ? 1 : 0,
        input.note ?? null,
        now,
        now
      );
    return this.get(id)!;
  }

  update(id: string, patch: Partial<NewRegistryEntry>): RegistryEntry | undefined {
    const current = this.get(id);
    if (!current) return undefined;
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE registry_entries SET
           kind = ?, adapter_id = ?, resource_type = ?, stable_key = ?, label = ?,
           custom_endpoint = ?, managed = ?, note = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(
        patch.kind ?? current.kind,
        patch.adapterId ?? current.adapterId ?? null,
        patch.resourceType ?? current.resourceType,
        patch.stableKey ?? current.stableKey,
        patch.label ?? current.label,
        patch.customEndpoint !== undefined ? patch.customEndpoint : (current.customEndpoint ?? null),
        patch.managed !== undefined ? (patch.managed ? 1 : 0) : current.managed ? 1 : 0,
        patch.note !== undefined ? patch.note : (current.note ?? null),
        now,
        id
      );
    return this.get(id);
  }

  remove(id: string): boolean {
    const result = this.db.prepare("DELETE FROM registry_entries WHERE id = ? AND host_id = ?").run(id, this.hostId);
    return Number(result.changes) > 0;
  }

  get(id: string): RegistryEntry | undefined {
    const row = this.db.prepare("SELECT * FROM registry_entries WHERE id = ? AND host_id = ?").get(id, this.hostId) as
      | RegistryRow
      | undefined;
    return row ? toEntry(row) : undefined;
  }
}