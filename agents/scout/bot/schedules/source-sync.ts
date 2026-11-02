import { defineSchedule } from "@grok/agent-sdk/schedules";

/** Every 4 hours UTC — keep linked websites fresh for in-silico research. */
export default defineSchedule({
  cron: "15 */4 * * *",
  async run({ callTool, waitUntil }) {
    waitUntil(callTool("sync_linked_sources", {}));
  },
});
