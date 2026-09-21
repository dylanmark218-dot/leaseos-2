import { defineConfig } from "drizzle-kit";
export default defineConfig({
  schema: "./drizzle/schema.ts",
  out: "/tmp/claude-0/-home-user-leaseos-2/959e7968-9910-5a85-b187-5ea25d56f5ef/scratchpad/dkold",
  dialect: "mysql",
  dbCredentials: { url: "mysql://u:p@127.0.0.1:3306/none" },
});
