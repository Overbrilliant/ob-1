import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

export default defineConfig({
  site: "https://docs.overbrilliant.com",
  integrations: [
    starlight({
      title: "OB-1 Docs",
      description: "Documentation for OB-1, the free open-source CLI coding agent.",
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/Overbrilliant/ob-1",
        },
      ],
      sidebar: [
        {
          label: "Getting Started",
          items: [
            { label: "Quickstart", slug: "getting-started/quickstart" },
            { label: "Install", slug: "getting-started/install" },
            { label: "FreeLLMAPI", slug: "getting-started/freellmapi" },
          ],
        },
        {
          label: "Concepts",
          items: [
            { label: "Core Concepts", slug: "concepts/core-concepts" },
            { label: "Memory", slug: "concepts/memory" },
            { label: "Multi-Agent Modes", slug: "concepts/multimind" },
          ],
        },
        {
          label: "Reference",
          items: [
            { label: "Commands", slug: "reference/commands" },
            { label: "Configuration", slug: "reference/configuration" },
            { label: "MCP", slug: "reference/mcp" },
            { label: "Hosted API", slug: "reference/hosted" },
          ],
        },
        {
          label: "Launch Assets",
          items: [
            { label: "Free-Tier Capacity", slug: "launch/free-tier-capacity" },
            { label: "Evals", slug: "launch/evals" },
          ],
        },
      ],
    }),
  ],
});
