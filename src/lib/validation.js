/**
 * Validation schemas using Zod
 */
import { z } from 'zod';

// Station name validation
export const stationNameSchema = z.string()
  .min(1, "Station name cannot be empty")
  .max(100, "Station name too long")
  .regex(/^[a-zA-Z0-9\s_#@-]+$/, "Station name contains invalid characters");

// Trigger interval validation (1 second to 24 hours)
export const triggerIntervalSchema = z.number()
  .int("Interval must be an integer")
  .min(1, "Interval must be at least 1 second")
  .max(86400, "Interval cannot exceed 24 hours");

// Property v2 validation
export const propertyV2Schema = z.object({
  version: z.literal(2, {
    errorMap: () => ({ message: "Property must be version 2" })
  }),
  width: z.number()
    .int("Width must be an integer")
    .min(1, "Width must be at least 1")
    .max(100, "Width cannot exceed 100"),
  height: z.number()
    .int("Height must be an integer")
    .min(1, "Height must be at least 1")
    .max(100, "Height cannot exceed 100"),
  floor: z.array(z.record(z.string(), z.unknown())).max(10000).optional(),
  assets: z.array(z.record(z.string(), z.unknown())).max(500),
  residents: z.array(z.string()).optional()
});

// Signal fire request validation
export const signalFireSchema = z.object({
  station: stationNameSchema,
  payload: z.unknown().optional()
});

// Signal interval update validation
export const signalIntervalSchema = z.object({
  station: stationNameSchema,
  interval: triggerIntervalSchema
});

// Tile catalog validation
const tileSchema = z.object({
  tx: z.number().int().optional(),
  ty: z.number().int().optional(),
  label: z.string().max(100).optional(),
  station: z.string().max(100).optional(),
  collision: z.union([z.boolean(), z.string().max(20)]).optional(),
  cutout: z.string().max(200).optional(),
}).passthrough();

export const tileCatalogSchema = z.object({
  categories: z.array(z.object({
    name: z.string().max(100),
    tileset: z.string().max(100).optional(),
    tiles: z.array(tileSchema).max(500),
  })).max(50),
}).passthrough();

// Property name validation (for file operations)
export const propertyNameSchema = z.string()
  .min(1, "Property name cannot be empty")
  .max(50, "Property name too long")
  .regex(/^[a-zA-Z0-9_-]+$/, "Property name can only contain letters, numbers, underscores, and hyphens");

// Agent state validation
export const agentStateSchema = z.object({
  agent_id: z.string().min(1).max(200),
  agent_name: z.string().max(100).optional(),
  state: z.string().min(1).max(100),
  detail: z.string().max(500).optional(),
  group: z.string().max(100).optional(),
  sprite: z.string().max(100).optional(),
  owner_id: z.string().max(200).optional(),
  owner_name: z.string().max(100).optional(),
  parent_agent_id: z.string().max(200).nullable().optional(),
  note: z.string().max(500).optional(),
});

// Asset CRUD validation
export const addAssetSchema = z.object({
  name: z.string().min(1, "Name is required").max(100),
  tileset: z.string().max(100).optional(),
  tx: z.number().int().optional(),
  ty: z.number().int().optional(),
  x: z.number().int().optional(),
  y: z.number().int().optional(),
  station: z.string().max(100).optional(),
  approach: z.enum(["above", "below", "left", "right"]).optional(),
  collision: z.boolean().optional(),
  remote_url: z.string().max(500).optional(),
  remote_station: z.string().max(100).optional(),
});

export const patchAssetSchema = z.object({
  position: z.object({ x: z.number().int(), y: z.number().int() }).optional(),
  content: z.object({
    type: z.string().max(50),
    data: z.string().max(100000),
    source: z.string().max(500).optional(),
    publishedAt: z.string().max(50).optional(),
  }).optional(),
}).refine(data => data.position || data.content, { message: "Must provide position or content" });

export const logEntrySchema = z.object({
  entry: z.string().min(1).max(500),
  isNote: z.boolean().optional(),
});

// Board post validation
export const boardPostSchema = z.object({
  data: z.string().min(1, "Data cannot be empty").max(10000, "Data cannot exceed 10KB"),
  type: z.enum(["text", "markdown", "json"]).optional(),
});

// Inbox message validation
export const inboxMessageSchema = z.object({
  from: z.string().min(1, "From cannot be empty").max(100, "From name too long"),
  text: z.string().min(1, "Text cannot be empty").max(2000, "Text cannot exceed 2000 characters"),
});

// Sprite filename validation
export const spriteFilenameSchema = z.string()
  .min(1, "Filename cannot be empty")
  .max(100, "Filename too long")
  .regex(/^[a-zA-Z0-9_-]+\.png$/, "Filename must be alphanumeric and end with .png");
