import { buildApp } from "./app";

const host = process.env.LMS_AIPANEL_HOST ?? "127.0.0.1";
const port = Number(process.env.LMS_AIPANEL_PORT ?? 3777);

async function main() {
  const built = await buildApp({ logger: true });
  await built.app.listen({ host, port });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});