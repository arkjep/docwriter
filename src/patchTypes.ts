import { z } from "zod";

export const replaceTextEditSchema = z.object({
  type: z.literal("replace_text"),
  target: z.object({
    paragraphIndex: z.number().int().min(0),
    startIndex: z.number().int().min(0),
    endIndex: z.number().int().min(0),
    currentText: z.string()
  }),
  replacementText: z.string()
});

export const patchProposalSchema = z.object({
  summary: z.string().min(1),
  edits: z.array(replaceTextEditSchema).max(50)
});

export type ReplaceTextEdit = z.infer<typeof replaceTextEditSchema>;
export type PatchProposal = z.infer<typeof patchProposalSchema>;

export type TextRunModel = {
  startIndex: number;
  endIndex: number;
  text: string;
  style?: Record<string, unknown>;
};

export type ParagraphModel = {
  paragraphIndex: number;
  startIndex: number;
  endIndex: number;
  text: string;
  textRuns: TextRunModel[];
  style?: Record<string, unknown>;
};

export type NormalizedDocument = {
  documentId: string;
  title: string;
  paragraphs: ParagraphModel[];
  fullText: string;
};

export type ValidationResult =
  | { ok: true }
  | { ok: false; reason: string; edit?: ReplaceTextEdit };
