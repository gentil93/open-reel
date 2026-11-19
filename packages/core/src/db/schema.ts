import {
	index,
	integer,
	real,
	sqliteTable,
	text,
} from "drizzle-orm/sqlite-core";
import type { ErrorParams } from "../errors";
import type {
	AssetKind,
	AssistantEntryBody,
	GenerationParams,
	JobStatus,
} from "../types";

export const sessions = sqliteTable(
	"sessions",
	{
		id: text("id").primaryKey(),
		userId: text("user_id").notNull(),
		title: text("title").notNull(),
		createdAt: integer("created_at").notNull(),
		updatedAt: integer("updated_at").notNull(),
	},
	(t) => [index("sessions_user_updated").on(t.userId, t.updatedAt)],
);

export const turns = sqliteTable(
	"turns",
	{
		id: text("id").primaryKey(),
		sessionId: text("session_id")
			.notNull()
			.references(() => sessions.id, { onDelete: "cascade" }),
		userId: text("user_id").notNull(),
		prompt: text("prompt").notNull(),
		referenceAssetIds: text("reference_asset_ids", { mode: "json" })
			.$type<string[]>()
			.notNull(),
		createdAt: integer("created_at").notNull(),
	},
	(t) => [index("turns_session_created").on(t.sessionId, t.createdAt)],
);

export const jobs = sqliteTable(
	"jobs",
	{
		id: text("id").primaryKey(),
		turnId: text("turn_id")
			.notNull()
			.references(() => turns.id, { onDelete: "cascade" }),
		position: integer("position").notNull(),
		userId: text("user_id").notNull(),
		providerId: text("provider_id").notNull(),
		modelId: text("model_id").notNull(),
		params: text("params", { mode: "json" })
			.$type<GenerationParams>()
			.notNull(),
		status: text("status").$type<JobStatus>().notNull(),
		handle: text("handle", { mode: "json" }).$type<unknown>(),
		error: text("error"),
		errorCode: text("error_code"),
		errorParams: text("error_params", { mode: "json" }).$type<ErrorParams>(),
		costUsd: real("cost_usd"),
		createdAt: integer("created_at").notNull(),
		startedAt: integer("started_at"),
		finishedAt: integer("finished_at"),
	},
	(t) => [index("jobs_turn").on(t.turnId), index("jobs_status").on(t.status)],
);

export const assets = sqliteTable(
	"assets",
	{
		id: text("id").primaryKey(),
		userId: text("user_id").notNull(),
		// Kept when the job is deleted so the gallery outlives its session.
		jobId: text("job_id").references(() => jobs.id, { onDelete: "set null" }),
		kind: text("kind").$type<AssetKind>().notNull(),
		hash: text("hash").notNull(),
		mime: text("mime").notNull(),
		size: integer("size").notNull(),
		prompt: text("prompt"),
		modelId: text("model_id"),
		params: text("params", { mode: "json" }).$type<GenerationParams>(),
		createdAt: integer("created_at").notNull(),
	},
	(t) => [
		index("assets_user_kind_created").on(t.userId, t.kind, t.createdAt),
		index("assets_job").on(t.jobId),
	],
);

/** What a person and the assistant said in a session, in order. */
export const messages = sqliteTable(
	"messages",
	{
		id: text("id").primaryKey(),
		sessionId: text("session_id")
			.notNull()
			.references(() => sessions.id, { onDelete: "cascade" }),
		userId: text("user_id").notNull(),
		body: text("body", { mode: "json" }).$type<AssistantEntryBody>().notNull(),
		createdAt: integer("created_at").notNull(),
	},
	(t) => [index("messages_session_created").on(t.sessionId, t.createdAt)],
);
