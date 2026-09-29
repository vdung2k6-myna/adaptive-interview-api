import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import express from "express";

import { createPersonasRouter, type PersonasDeps } from "./personas";
import { apiAuthMiddleware } from "../middleware/auth";
import { DEFAULT_ANSWER_MODE, type PersonaRow } from "../lib/personas";

/** The token this suite arms auth with. Deliberately not the developer's: an
 * unset `API_AUTH_TOKEN` disables authentication entirely, which would make the
 * unauthorized assertion below pass for the wrong reason. */
const TOKEN = "test-token-for-the-persona-catalog";

/** A complete row, so each test below states only the field it is about. */
function personaRow(overrides: Partial<PersonaRow> = {}): PersonaRow {
  return {
    id: "friendly-tutor",
    label: "Friendly Tutor",
    emoji: "🎓",
    defaultPrompt: "You are a friendly tutor.",
    knowledgeTopics: ["Truyện cười"],
    answerMode: DEFAULT_ANSWER_MODE,
    sortOrder: 20,
    ...overrides,
  };
}

/** The catalog as bound for one test. */
interface Catalog {
  /** Where it is. A request here without `authorized` carries no credential. */
  url: string;
  /** A request the auth middleware accepts. */
  authorized: () => Promise<Response>;
}

/**
 * Mount the router behind the real auth middleware on a bare app, with an
 * injected catalog, bound to an ephemeral port — so the catalog is asserted
 * over HTTP, through the middleware the composition root puts in front of it,
 * with no database anywhere.
 *
 * The middleware is mounted here rather than assumed because this is the only
 * place both halves of the requirement can be asserted without one: the root's
 * own suite can prove a request without a token is rejected, but proving a
 * *valid* one reaches the catalog there would mean reading a database.
 */
async function withServer(
  lister: PersonaRow[] | (() => Promise<PersonaRow[]>),
  fn: (catalog: Catalog) => Promise<void>
): Promise<void> {
  const previousToken = process.env.API_AUTH_TOKEN;
  process.env.API_AUTH_TOKEN = TOKEN;

  const app = express();
  app.use(express.json());
  app.use("/api", apiAuthMiddleware);
  app.use(
    "/api/personas",
    createPersonasRouter({
      listPersonas: typeof lister === "function" ? lister : async () => lister,
    } satisfies Partial<PersonasDeps>)
  );

  let server: Server | undefined;
  try {
    server = await new Promise<Server>((resolve) => {
      const bound = app.listen(0, "127.0.0.1", () => resolve(bound));
    });

    const address = server.address();
    assert.ok(address && typeof address === "object", "expected the app to bind a port");
    const url = `http://127.0.0.1:${address.port}/api/personas`;

    await fn({
      url,
      authorized: () => fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } }),
    });
  } finally {
    if (server) {
      // A keep-alive socket would otherwise hold `close()` open for its idle
      // timeout.
      server.closeAllConnections();
      await new Promise<void>((resolve) => server?.close(() => resolve()));
    }

    if (previousToken === undefined) delete process.env.API_AUTH_TOKEN;
    else process.env.API_AUTH_TOKEN = previousToken;
  }
}

/** Run `fn` with the route's error log captured rather than printed. */
async function captureErrors<T>(fn: () => Promise<T>): Promise<{ result: T; errors: string[] }> {
  const real = console.error;
  const errors: string[] = [];
  console.error = ((...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  }) as typeof console.error;

  try {
    return { result: await fn(), errors };
  } finally {
    console.error = real;
  }
}

describe("GET /api/personas", () => {
  it("answers a request with no credential as unauthorized, as every API resource does", async () => {
    await withServer([personaRow()], async (catalog) => {
      const res = await fetch(catalog.url);

      assert.equal(res.status, 401);
    });
  });

  it("reports every declared field of every persona, as a list", async () => {
    await withServer(
      [personaRow(), personaRow({ id: "custom-3", label: "Custom 3", knowledgeTopics: [], sortOrder: 30 })],
      async (catalog) => {
        const res = await catalog.authorized();

        assert.equal(res.status, 200);

        const body: unknown = await res.json();
        assert.ok(Array.isArray(body), "the catalog is a list of personas, not an object wrapping one");

        assert.deepEqual(body, [
          {
            id: "friendly-tutor",
            label: "Friendly Tutor",
            emoji: "🎓",
            defaultPrompt: "You are a friendly tutor.",
            knowledgeTopics: ["Truyện cười"],
            answerMode: "generate",
          },
          {
            id: "custom-3",
            label: "Custom 3",
            emoji: "🎓",
            defaultPrompt: "You are a friendly tutor.",
            knowledgeTopics: [],
            answerMode: "generate",
          },
        ]);
      }
    );
  });

  it("orders the catalog by sort order", async () => {
    await withServer(
      [
        personaRow({ id: "third", sortOrder: 30 }),
        personaRow({ id: "first", sortOrder: 10 }),
        personaRow({ id: "second", sortOrder: 20 }),
      ],
      async (catalog) => {
        const body = (await (await catalog.authorized()).json()) as { id: string }[];

        assert.deepEqual(
          body.map((entry) => entry.id),
          ["first", "second", "third"]
        );
      }
    );
  });

  it("reports a persona that declares no knowledge topics as one that offers none", async () => {
    await withServer([personaRow({ id: "bare", knowledgeTopics: [] })], async (catalog) => {
      const body = (await (await catalog.authorized()).json()) as {
        id: string;
        knowledgeTopics: string[];
      }[];

      assert.equal(body.length, 1, "a persona with no topics is still a persona the client can start");
      assert.deepEqual(body[0].knowledgeTopics, []);
    });
  });

  it("reports a persona stored without an answer mode as generating", async () => {
    await withServer([personaRow({ id: "pre-existing", answerMode: null })], async (catalog) => {
      const body = (await (await catalog.authorized()).json()) as { answerMode: string }[];

      assert.equal(
        body[0].answerMode,
        DEFAULT_ANSWER_MODE,
        "a persona that predates answer modes must keep the behaviour it had"
      );
    });
  });

  it("answers a catalog that cannot be read as a failure rather than an empty one", async () => {
    const { errors } = await captureErrors(() =>
      withServer(
        async () => {
          throw new Error("connection terminated unexpectedly");
        },
        async (catalog) => {
          const res = await catalog.authorized();

          assert.equal(res.status, 500);
          assert.deepEqual(await res.json(), { error: "Failed to load personas" });
        }
      )
    );

    assert.ok(
      errors.some((line) => line.includes("GET /api/personas error:")),
      "the failure is logged with the route that failed, or it is invisible in production"
    );
  });
});
