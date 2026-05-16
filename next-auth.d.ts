import NextAuth from "next-auth"

declare module "next-auth" {
  /**
   * Returned by `useSession`, `getSession` and received as a prop on the `SessionProvider` React Context
   */
  interface Session {
    user: {
      /** The user's id from the database */
      id?: string | null
      /** The user's email address */
      email?: string | null
      /** Whether the user is a developer account */
      isDeveloperAccount?: boolean | null
    }
  }
}

declare module "next-auth/jwt" {
  /** Returned by the `jwt` callback and `getToken`, this is an optional extended JWT */
  interface JWT {
    /** The user's id from the database */
    id?: string | null
    /** The user's email address */
    email?: string | null
    /** Whether the user is a developer account */
    isDeveloperAccount?: boolean | null
  }
}