import type { Metadata } from "next";
import { PageHead } from "@/components/ui";
import { getT } from "@/lib/i18n/server";
import { SettingsClient } from "./SettingsClient";

export const metadata: Metadata = { title: "Settings" };

export default async function Settings() {
  const { t } = await getT();
  return (
    <div className="max-w-3xl">
      <PageHead title={t("nav.settings")} />
      <SettingsClient />
    </div>
  );
}
