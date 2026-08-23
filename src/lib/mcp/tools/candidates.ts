import { db } from "@/lib/db";
import { candidates } from "@/lib/schema";
import { z } from "zod";
import { getAnonymizedCandidateUuid } from "./_anonymize";

export const searchCandidatesBySkillSchema = z.object({
  skill: z.string().min(1),
  limit: z.number().int().min(1).max(500).optional().default(50),
});

export async function searchCandidatesBySkill(args: z.infer<typeof searchCandidatesBySkillSchema>) {
  const { skill, limit } = args;
  const searchLower = skill.toLowerCase().trim();

  const candidateRows = await db.select().from(candidates).limit(limit);

  const matched = candidateRows
    .map((c) => {
      const matchedSkills = c.skills.filter((s) => s.toLowerCase().includes(searchLower));
      return {
        candidate: c,
        matchedSkills,
      };
    })
    .filter((item) => item.matchedSkills.length > 0)
    .sort((a, b) => b.matchedSkills.length - a.matchedSkills.length);

  return matched.map((item) => ({
    candidateUuid: getAnonymizedCandidateUuid(item.candidate.id),
    matchedSkills: item.matchedSkills,
    experienceYears: item.candidate.experienceYears,
  }));
}
