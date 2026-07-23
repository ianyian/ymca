import "dotenv/config";
import { prisma } from "../src/lib/prisma.js";
import { seedDemoActivityForUser } from "../src/domain/user-analytics.js";

type CliArgs = {
  email: string | null;
  userId: string | null;
  help: boolean;
};

function parseArgs(argv: string[]): CliArgs {
  let email: string | null = process.env.EMAIL ?? null;
  let userId: string | null = process.env.USER_ID ?? null;
  let help = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    if (arg === "--email" && argv[i + 1]) {
      email = argv[i + 1]!;
      i += 1;
      continue;
    }
    if (arg === "--user-id" && argv[i + 1]) {
      userId = argv[i + 1]!;
      i += 1;
      continue;
    }
    if (arg.startsWith("--email=")) {
      email = arg.slice("--email=".length);
      continue;
    }
    if (arg.startsWith("--user-id=")) {
      userId = arg.slice("--user-id=".length);
      continue;
    }
  }

  return { email, userId, help };
}

function printUsage() {
  console.log(
    [
      "Seed demo analytics rows for one existing user.",
      "",
      "Usage:",
      "  pnpm --filter @ymca/api seed:demo-analytics -- --email you@example.com",
      "  pnpm --filter @ymca/api seed:demo-analytics -- --user-id <uuid>",
      "",
      "You can also set EMAIL or USER_ID in the environment.",
    ].join("\n"),
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help || (!args.email && !args.userId)) {
    printUsage();
    process.exit(args.help ? 0 : 1);
  }

  const user = args.userId
    ? await prisma.user.findUnique({
        where: { id: args.userId },
        select: { id: true, email: true },
      })
    : await prisma.user.findUnique({
        where: { email: args.email! },
        select: { id: true, email: true },
      });

  if (!user) {
    console.error(args.userId ? `No user found for id ${args.userId}` : `No user found for email ${args.email}`);
    process.exit(1);
  }

  const result = await seedDemoActivityForUser(user.id);

  if (result.skipped) {
    console.log(`No demo rows inserted for ${user.email}; the user already has real activity or matching demo rows.`);
  } else {
    console.log(`Seeded ${result.seededRecords} activity rows across ${result.seededDays} day(s) for ${user.email}.`);
  }

  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});