import { z } from "zod";

export const VacancySourceTypeSchema = z.enum(["url", "raw_text"]);
export type VacancySourceType = z.infer<typeof VacancySourceTypeSchema>;

export const VacancyInputSchema = z.object({
  sourceType: VacancySourceTypeSchema,
  source: z.string().min(1),
});
export type VacancyInput = z.infer<typeof VacancyInputSchema>;

export const EmploymentTypeSchema = z.enum([
  "full_time",
  "part_time",
  "contract",
  "internship",
  "temporary",
  "unknown",
]);
export type EmploymentType = z.infer<typeof EmploymentTypeSchema>;

export const NormalizedVacancySchema = z.object({
  company: z.string(),
  title: z.string(),
  location: z.string(),
  employmentType: EmploymentTypeSchema,
  requirements: z.array(z.string()),
  responsibilities: z.array(z.string()),
  benefits: z.array(z.string()),
  applicationQuestions: z.array(z.string()),
  keywords: z.array(z.string()),
});
export type NormalizedVacancy = z.infer<typeof NormalizedVacancySchema>;
