import { Temporal } from "@js-temporal/polyfill";
import { ownerSession, signIn, signOut } from "../src/hosted/auth";
import { HostedDashboard } from "../src/hosted/dashboard";
import { reportTimezone } from "../src/core/report-period";
export const dynamic = "force-dynamic";
export default async function Page() {
  const owner = await ownerSession();
  if (!owner)
    return (
      <>
        <h1>Shiplog</h1>
        <p>Private work reports. Sign in with the configured owner account.</p>
        <form
          action={async () => {
            "use server";
            await signIn("google");
          }}
        >
          <button>Sign in with Google</button>
        </form>
      </>
    );
  const timezone = reportTimezone(process.env.REPORT_TIMEZONE ?? "UTC");
  const date = Temporal.Now.zonedDateTimeISO(timezone).toPlainDate().toString();
  return (
    <>
      <nav>
        <strong>Shiplog</strong>
        <form
          action={async () => {
            "use server";
            await signOut();
          }}
        >
          <button>Sign out</button>
        </form>
      </nav>
      <HostedDashboard timezone={timezone} date={date} />
    </>
  );
}
