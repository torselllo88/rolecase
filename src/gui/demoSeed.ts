import { createAnswerExampleEntry, listAnswerExampleEntries } from "../tools/answerExampleLibrary.js";
import { createCandidateNoteEntry, listCandidateNoteEntries } from "../tools/candidateNotesLibrary.js";
import { createCoverLetterEntry, listCoverLetterEntries } from "../tools/coverLetterLibrary.js";
import { createResumeTextEntry, listResumeFiles } from "../tools/resumeLibrary.js";

const SAMPLE_RESUME_TEXT = `Daniel Mercer
Senior Backend Engineer
Berlin, Germany
daniel.mercer@example.com
github.com/dmercer-dev

Summary

Senior Backend Engineer with 8+ years of experience building high-throughput APIs, distributed
services, and data-intensive backend systems. Strong background in TypeScript, Node.js,
PostgreSQL, Kafka, and AWS. Experienced in service decomposition, performance optimization,
production reliability, and technical leadership.

Experience

Senior Backend Engineer — CloudLedger
Berlin, Germany · 2022–Present
- Designed and maintained backend services for a B2B payments platform processing more than 4
  million API requests per day.
- Led the migration of several core services from a legacy monolith to independently deployable
  Node.js services.
- Reduced p95 API latency from approximately 480 ms to 190 ms through query optimization,
  caching, and asynchronous processing.
- Introduced Kafka-based event processing for payment status updates and reconciliation
  workflows.
- Improved production observability using OpenTelemetry, Grafana, and structured logging.
- Mentored three backend engineers and regularly participated in architecture reviews.

Backend Engineer — ParcelGrid
Hamburg, Germany · 2019–2022
- Developed APIs and asynchronous processing services for a logistics platform used by
  enterprise customers across Europe.
- Built integrations with external carrier APIs and internal warehouse systems.
- Designed PostgreSQL data models for shipment tracking and billing workflows.
- Introduced Redis caching for high-volume tracking endpoints, reducing database load by
  roughly 35%.
- Helped migrate deployment infrastructure from manually managed VMs to Kubernetes on AWS.

Software Engineer — Northstar Digital
Berlin, Germany · 2017–2019
- Developed backend functionality for several SaaS products using JavaScript, Node.js, and
  PostgreSQL.
- Implemented REST APIs, authentication flows, background jobs, and third-party integrations.
- Worked closely with frontend engineers and product managers in small cross-functional teams.

Education

B.Sc. Computer Science
Technical University of Berlin · 2013–2017

Technical skills

Languages: TypeScript, JavaScript, Python, SQL
Backend: Node.js, Express, Fastify
Data: PostgreSQL, Redis, Kafka
Infrastructure: AWS, Docker, Kubernetes, Terraform
Observability: OpenTelemetry, Grafana, Prometheus
Testing: Vitest, Jest, integration testing`;

const SAMPLE_ANSWER_EXAMPLES: Array<{ question: string; answer: string }> = [
  {
    question: "Why are you looking for a new role?",
    answer: `I'm looking for a role where backend engineering is treated as a product capability rather than just an implementation function. In my current position I've increasingly been involved in architecture decisions, reliability work, and mentoring, and I'd like my next role to give me more ownership over those areas while still remaining hands-on.`,
  },
  {
    question: "Tell us about a technically challenging project you worked on.",
    answer: `One of the more challenging projects at CloudLedger was separating payment processing from a legacy monolith while the system remained in active use. We couldn't afford a long migration window or inconsistent transaction state.

We moved the workflow incrementally, introduced event-driven communication through Kafka, and ran old and new processing paths in parallel during part of the migration. My main responsibility was the service architecture and the interfaces between the existing platform and the new components.

The migration reduced coupling between payment processing and the rest of the application and made deployments considerably safer.`,
  },
  {
    question: "What are you looking for in your next team?",
    answer: `I work best in teams where engineers have enough context to understand why something is being built and are expected to contribute to technical decisions. I prefer relatively small teams with clear ownership and direct communication between engineering and product.

I also value environments where reliability and maintainability are considered part of delivery rather than something postponed until later.`,
  },
  {
    question: "Describe your experience with distributed systems.",
    answer: `Most of my recent work has involved systems distributed across multiple services rather than large-scale distributed computing in the academic sense. At CloudLedger, I work with asynchronous payment workflows built around Kafka, independently deployed services, PostgreSQL, Redis, and external payment providers.

The main challenges have been consistency, retries, idempotency, failure recovery, and observability. I have designed services around these constraints and participated in incident analysis when those assumptions failed in production.`,
  },
  {
    question: "What is your experience with AWS?",
    answer: `I've used AWS in production for approximately five years. My recent work has primarily involved ECS and EKS-based workloads, RDS, S3, CloudWatch, IAM, and managed networking components.

I have also worked with Terraform for infrastructure changes, although I would describe myself as an experienced infrastructure consumer rather than a dedicated platform engineer.`,
  },
];

const SAMPLE_COVER_LETTERS: string[] = [
  `Dear Hiring Team,

I'm applying for the Senior Backend Engineer position because the role closely matches the kind of backend work I've been doing over the past several years: transactional systems, asynchronous workflows, and APIs where reliability matters as much as feature delivery.

At CloudLedger, I work on a B2B payments platform handling more than four million API requests per day. My recent work has included decomposing parts of a legacy backend into independently deployable services, introducing Kafka-based event processing, and improving API performance. One optimization project reduced p95 latency from roughly 480 ms to 190 ms.

What interests me particularly about this role is the combination of hands-on backend engineering and architectural ownership. I'm most useful in teams where I can contribute to implementation while also helping make decisions about service boundaries, reliability, and operational trade-offs.

I'd be interested in discussing how my experience with Node.js, PostgreSQL, Kafka, and AWS could fit your engineering team.

Best,
Daniel Mercer`,
  `Dear Hiring Team,

Your Senior Backend Engineer opening caught my attention because it combines product-facing backend development with work on scalability and platform reliability.

I've spent the last eight years building backend systems, most recently at CloudLedger and ParcelGrid. My work has ranged from designing APIs and data models to service decomposition, event-driven processing, and production observability. At ParcelGrid, I also participated in the migration from manually managed virtual machines to Kubernetes on AWS.

I don't consider infrastructure a separate concern from application development. Many of the most important backend decisions I've worked on involved understanding how software behaves after deployment: how failures are detected, how retries behave, and whether a service can be changed without creating operational risk.

I'm now looking for a team where that kind of engineering ownership is expected from senior developers, while still keeping the role strongly hands-on.

Best regards,
Daniel Mercer`,
];

const SAMPLE_CANDIDATE_NOTES: string[] = [
  `Career preferences

- Prefer backend/platform roles over full-stack.
- Interested in fintech, developer tools, B2B SaaS, and infrastructure products.
- Not interested in adtech or gambling.
- Prefer companies where senior engineers remain hands-on.
- Comfortable mentoring, but not currently looking for a pure engineering-manager role.
- Open to remote roles within Europe or hybrid roles in Berlin.
- Target compensation: EUR 95k+, depending on equity and responsibilities.
- Prefer TypeScript/Node.js roles, but open to Python-heavy teams.`,
  `Do not claim, in any generated application material:

- Staff-level experience.
- Direct people-management responsibility.
- Deep Kubernetes/platform engineering expertise.
- Experience with Go or Java.
- Experience processing billions of requests.

These are outside my actual experience — I have led migrations and mentored engineers, but I
have not managed people directly, and my Kubernetes/AWS experience is as an experienced
consumer of the platform, not a dedicated infrastructure engineer.`,
];

/**
 * A fresh /demo workspace starts with empty libraries — a first-time visitor
 * has nothing to paste and nothing to select, which defeats the point of a
 * one-click demo. Seeds a single fictional candidate (resume, past answers,
 * past cover letters, and — deliberately — a couple of explicit "don't claim
 * this" notes) so a hands-off visitor gets a real, grounded result. Runs once
 * at startup, inside runWithWorkspace(demoDescriptor, ...) — see server.ts.
 * Guarded on the resume library alone: if that's non-empty, either seeding
 * already happened or someone deliberately curated demo's content, so every
 * other library is left alone too rather than partially re-seeding one but
 * not the others.
 */
export function seedDemoWorkspaceIfEmpty(): void {
  if (listResumeFiles().length > 0) return;

  createResumeTextEntry("Daniel Mercer", SAMPLE_RESUME_TEXT);

  if (listAnswerExampleEntries().length === 0) {
    for (const example of SAMPLE_ANSWER_EXAMPLES) createAnswerExampleEntry(example);
  }
  if (listCoverLetterEntries().length === 0) {
    for (const letter of SAMPLE_COVER_LETTERS) createCoverLetterEntry(letter);
  }
  if (listCandidateNoteEntries().length === 0) {
    for (const note of SAMPLE_CANDIDATE_NOTES) createCandidateNoteEntry(note);
  }
}
