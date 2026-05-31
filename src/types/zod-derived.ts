/**
 * Zod-derived TypeScript types — single source of truth.
 *
 * All types are derived from src/types/schemas.ts via z.infer<>.
 * Never hand-write an interface that duplicates a Zod schema;
 * import the schema and derive the type here instead.
 */

import type {
  AttachmentSchema,
  TokenUsageSchema,
  UsageCostSchema,
  ToolRunSchema,
  ToolJobSchema,
  ToolSourceSchema,
  ToolCitationSchema,
  AgentStageSchema,
  TaskCheckpointSchema,
  CrewMemberSchema,
  AgentRunSchema,
  MessageVersionSchema,
  ChatMessageSchema,
  SettingsSchema,
  StorageStatusSchema,
} from '../types/schemas.js';
import type { z } from 'zod';

export type Attachment = z.infer<typeof AttachmentSchema>;
export type TokenUsage = z.infer<typeof TokenUsageSchema>;
export type UsageCost = z.infer<typeof UsageCostSchema>;
export type ToolRun = z.infer<typeof ToolRunSchema>;
export type ToolJob = z.infer<typeof ToolJobSchema>;
export type ToolSource = z.infer<typeof ToolSourceSchema>;
export type ToolCitation = z.infer<typeof ToolCitationSchema>;
export type AgentStage = z.infer<typeof AgentStageSchema>;
export type TaskCheckpoint = z.infer<typeof TaskCheckpointSchema>;
export type CrewMember = z.infer<typeof CrewMemberSchema>;
export type AgentRun = z.infer<typeof AgentRunSchema>;
export type MessageVersion = z.infer<typeof MessageVersionSchema>;
export type ChatMessage = z.infer<typeof ChatMessageSchema>;
export type Settings = z.infer<typeof SettingsSchema>;
export type StorageStatus = z.infer<typeof StorageStatusSchema>;
