import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import { permitsGoogle, authenticatedOwner } from "./access.ts";
export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [Google],
  session: { strategy: "jwt" },
  callbacks: {
    signIn: ({ profile }) => permitsGoogle(profile, process.env.OWNER_EMAIL),
    jwt({ token, profile }) {
      if (profile?.email) token.email = profile.email.trim().toLowerCase();
      return token;
    },
  },
});
export async function ownerSession() {
  const session = await auth();
  return authenticatedOwner(session?.user?.email, process.env.OWNER_EMAIL);
}
