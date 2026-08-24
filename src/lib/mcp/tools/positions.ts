import { getPositionsWithSessionCount } from "@/lib/position-queries";
import { z } from "zod";

export const listPositionsSchema = z.object({
  level: z.string().optional(),
});

export async function listPositions(args: z.infer<typeof listPositionsSchema>) {
  const { level } = args;

  const positionRows = await getPositionsWithSessionCount({ level });

  return positionRows.map((p) => ({
    id: p.id,
    title: p.title,
    level: p.level,
    requirements: p.requirements,
    sessionCount: p.sessionCount,
  }));
}
