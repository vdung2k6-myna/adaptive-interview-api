#!/usr/bin/env node
/**
 * Verify every service in the audio-tier compose project is running and
 * healthy.
 *
 * The start scripts call this so a missing service is a failed start, not a
 * silent skip: `docker compose up -d` returns successfully even when a
 * container immediately exits. Exits 0 only when every service passes.
 */

const { spawnSync } = require("child_process");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const COMPOSE_FILE = path.join(ROOT, "docker-compose.audio.yml");
const POLL_MS = 3000;

function docker(args) {
  return spawnSync("docker", args, { encoding: "utf8", cwd: ROOT });
}

function waitSeconds() {
  const index = process.argv.indexOf("--wait-seconds");
  const value = index !== -1 ? Number(process.argv[index + 1]) : 180;
  return Number.isFinite(value) && value > 0 ? value : 180;
}

function serviceNames() {
  const result = docker(["compose", "-f", COMPOSE_FILE, "config", "--services"]);
  if (result.status !== 0) {
    console.error(result.stderr || "could not list compose services");
    process.exit(1);
  }
  return result.stdout.trim().split(/\r?\n/).filter(Boolean);
}

function containerRows() {
  const result = docker(["compose", "-f", COMPOSE_FILE, "ps", "--format", "json"]);
  if (result.status !== 0) {
    return [];
  }
  const raw = result.stdout.trim();
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    // Older compose versions emit one JSON object per line.
    return raw
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  }
}

/**
 * Returns a list of {service, state} problems. A scaled service passes only
 * when every one of its containers is running and healthy.
 */
function problems(names, rows) {
  const found = [];
  for (const name of names) {
    const containers = rows.filter((row) => row.Service === name);
    if (containers.length === 0) {
      found.push({ service: name, state: "missing" });
      continue;
    }
    for (const container of containers) {
      if (container.State !== "running") {
        found.push({ service: name, state: container.State || "not running" });
        break;
      }
      const health = container.Health || "";
      if (health && health !== "healthy") {
        found.push({ service: name, state: health });
        break;
      }
    }
  }
  return found;
}

function printProblems(list) {
  for (const item of list) {
    console.log(`  ${item.service.padEnd(14)} ${item.state}`);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const names = serviceNames();
  if (names.length === 0) {
    console.error("[FAIL] the compose project declares no services");
    process.exit(1);
  }

  const deadline = Date.now() + waitSeconds() * 1000;
  let last = [];
  process.stdout.write(`Waiting for ${names.length} audio services to become healthy`);

  while (true) {
    last = problems(names, containerRows());
    if (last.length === 0) {
      process.stdout.write("\n");
      console.log("All audio services are healthy:");
      for (const name of names) {
        console.log(`  ${name.padEnd(14)} healthy`);
      }
      return;
    }
    if (Date.now() >= deadline) {
      process.stdout.write("\n");
      console.error("[FAIL] the audio tier is not healthy:");
      printProblems(last);
      console.error("       Check: docker compose -f docker-compose.audio.yml logs");
      process.exit(1);
    }
    process.stdout.write(".");
    await sleep(POLL_MS);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
