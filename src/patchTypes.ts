import { z } from "zod";

export const replaceTextEditSchema = z.object({
  type: z.literal("replace_text"),
  target: z.object({
    tabId: z.string().optional(),
    paragraphIndex: z.number().int().min(0),
    startIndex: z.number().int().min(0),
    endIndex: z.number().int().min(0),
    currentText: z.string()
  }),
  replacementText: z.string()
});

const paragraphTargetSchema = z.object({
  tabId: z.string().optional(),
  paragraphIndex: z.number().int().min(0),
  startIndex: z.number().int().min(0),
  endIndex: z.number().int().min(0)
});

const dimensionSchema = z.object({
  magnitude: z.number(),
  unit: z.string().default("PT")
});

export const updateParagraphStyleEditSchema = z.object({
  type: z.literal("update_paragraph_style"),
  target: paragraphTargetSchema,
  paragraphStyle: z.record(z.unknown()),
  fields: z.string().min(1)
});

export const updateTextStyleEditSchema = z.object({
  type: z.literal("update_text_style"),
  target: paragraphTargetSchema,
  textStyle: z.record(z.unknown()),
  fields: z.string().min(1)
});

export const createParagraphBulletsEditSchema = z.object({
  type: z.literal("create_paragraph_bullets"),
  target: paragraphTargetSchema,
  bulletPreset: z.string().default("BULLET_DISC_CIRCLE_SQUARE")
});

export const deleteParagraphBulletsEditSchema = z.object({
  type: z.literal("delete_paragraph_bullets"),
  target: paragraphTargetSchema
});

export const patchEditSchema = z.discriminatedUnion("type", [
  replaceTextEditSchema,
  updateParagraphStyleEditSchema,
  updateTextStyleEditSchema,
  createParagraphBulletsEditSchema,
  deleteParagraphBulletsEditSchema
]);

export const patchProposalSchema = z.object({
  summary: z.string().min(1),
  edits: z.array(patchEditSchema).max(50)
});

export type ReplaceTextEdit = z.infer<typeof replaceTextEditSchema>;
export type UpdateParagraphStyleEdit = z.infer<typeof updateParagraphStyleEditSchema>;
export type UpdateTextStyleEdit = z.infer<typeof updateTextStyleEditSchema>;
export type CreateParagraphBulletsEdit = z.infer<typeof createParagraphBulletsEditSchema>;
export type DeleteParagraphBulletsEdit = z.infer<typeof deleteParagraphBulletsEditSchema>;
export type PatchEdit = z.infer<typeof patchEditSchema>;
export type PatchProposal = z.infer<typeof patchProposalSchema>;

export type DimensionModel = z.infer<typeof dimensionSchema>;

export type TextRunModel = {
  tabId?: string;
  startIndex: number;
  endIndex: number;
  text: string;
  style?: Record<string, unknown>;
};

export type ParagraphModel = {
  tabId?: string;
  tabTitle?: string;
  paragraphIndex: number;
  startIndex: number;
  endIndex: number;
  text: string;
  textRuns: TextRunModel[];
  style?: Record<string, unknown>;
  bullet?: {
    listId?: string;
    nestingLevel?: number;
    glyphType?: string;
    glyphSymbol?: string;
    startNumber?: number;
  };
};

export type TabModel = {
  tabId: string;
  title: string;
  depth: number;
  paragraphs: ParagraphModel[];
};

export type NormalizedDocument = {
  documentId: string;
  title: string;
  tabs: TabModel[];
  paragraphs: ParagraphModel[];
  fullText: string;
};

export type ValidationResult =
  | { ok: true }
  | { ok: false; reason: string; edit?: ReplaceTextEdit };
