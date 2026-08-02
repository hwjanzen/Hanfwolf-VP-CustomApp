import { execSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function ensureSessionTable() {
  try {
    await prisma.session.count();
    console.info("[startup] Prisma Session table is available.");
    return;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    // P2021 means the underlying table does not exist.
    if (!message.includes("P2021") && !message.includes("does not exist")) {
      throw error;
    }

    console.warn("[startup] Session table missing. Running prisma db push fallback...");
    execSync("npx prisma db push --schema ./prisma/schema.prisma --skip-generate", {
      stdio: "inherit",
    });
    await prisma.session.count();
    console.info("[startup] Session table created and verified.");
  }
}

try {
  await ensureSessionTable();
} finally {
  await prisma.$disconnect();
}
