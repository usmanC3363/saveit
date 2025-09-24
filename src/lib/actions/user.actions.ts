"use server";

import { createAdminClient, createSessionClient } from "@/lib/appwrite";
import { appwriteConfig } from "@/lib/appwrite/config";
import { Query, ID } from "node-appwrite";
import { parseStringify } from "@/lib/utils";
import { cookies } from "next/headers";
import { avatarPlaceholderUrl } from "@/constants";
import { redirect } from "next/navigation";

const handleError = (error: unknown, message: string) => {
  console.error(message, error);
  throw error;
};

/**
 * Ensure a single string attribute exists on a collection; create it if missing.
 */
const ensureStringAttribute = async (
  databases: any,
  databaseId: string,
  collectionId: string,
  key: string,
  size = 255,
  required = false,
) => {
  // Try to list attributes and detect whether `key` already exists
  const attrsResp = await databases.listAttributes(databaseId, collectionId);
  // SDK shapes can vary across versions; handle both possible shapes
  const attrsArray = Array.isArray(attrsResp.attributes)
    ? attrsResp.attributes
    : Array.isArray(attrsResp)
      ? attrsResp
      : [];

  const exists = attrsArray.some((a: any) => a.key === key || a.$id === key);
  if (exists) return false; // nothing created

  // Create string attribute
  // createStringAttribute signature used earlier: (databaseId, collectionId, key, size, required)
  await databases.createStringAttribute(
    databaseId,
    collectionId,
    key,
    size,
    required,
  );
  return true; // created
};

/**
 * Ensure multiple attributes exist; returns list of created attributes
 */
const ensureAttributes = async (
  databases: any,
  databaseId: string,
  collectionId: string,
  keys: string[],
) => {
  const created: string[] = [];
  for (const key of keys) {
    try {
      const didCreate = await ensureStringAttribute(
        databases,
        databaseId,
        collectionId,
        key,
      );
      if (didCreate) {
        console.log(
          `Attribute "${key}" created in collection ${collectionId}.`,
        );
        created.push(key);
      } else {
        console.log(
          `Attribute "${key}" already exists in collection ${collectionId}.`,
        );
      }
    } catch (err) {
      console.error(`Failed ensuring attribute "${key}":`, err);
      throw err;
    }
  }
  return created;
};

// --- existing functions (slightly refactored but same behavior) ---
const getUserByEmail = async (email: string) => {
  const { databases } = await createAdminClient();

  const result = await databases.listDocuments(
    appwriteConfig.databaseId,
    appwriteConfig.usersCollectionId,
    [Query.equal("email", [email])],
  );

  return result.total > 0 ? result.documents[0] : null;
};

export const sendEmailOTP = async ({ email }: { email: string }) => {
  const { account } = await createAdminClient();

  try {
    const session = await account.createEmailToken(ID.unique(), email);
    return session.userId;
  } catch (error) {
    handleError(error, "Failed to send email OTP");
  }
};

export const createAccount = async ({
  fullName,
  email,
}: {
  fullName: string;
  email: string;
}) => {
  const existingUser = await getUserByEmail(email);

  const accountId = await sendEmailOTP({ email });
  if (!accountId) throw new Error("Failed to send an OTP");

  if (!existingUser) {
    const { databases } = await createAdminClient();

    // ensure the attributes we will write exist
    const keysToEnsure = ["fullName", "email", "avatar", "accountId"];
    try {
      await ensureAttributes(
        databases,
        appwriteConfig.databaseId,
        appwriteConfig.usersCollectionId,
        keysToEnsure,
      );
    } catch (err) {
      handleError(err, "Failed to ensure collection attributes");
    }

    // Now create the document
    try {
      await databases.createDocument(
        appwriteConfig.databaseId,
        appwriteConfig.usersCollectionId,
        ID.unique(),
        {
          fullName,
          email,
          avatar: avatarPlaceholderUrl,
          accountId,
        },
      );
    } catch (err: any) {
      console.error("createDocument failed:", err);
      // If it still fails, surface the message so you can inspect missing/invalid attributes
      throw err;
    }
  }

  return parseStringify({ accountId });
};

export const verifySecret = async ({
  accountId,
  password,
}: {
  accountId: string;
  password: string;
}) => {
  try {
    const { account } = await createAdminClient();

    const session = await account.createSession(accountId, password);

    (await cookies()).set("appwrite-session", session.secret, {
      path: "/",
      httpOnly: true,
      sameSite: "strict",
      secure: true,
    });

    return parseStringify({ sessionId: session.$id });
  } catch (error) {
    handleError(error, "Failed to verify OTP");
  }
};

export const getCurrentUser = async () => {
  try {
    const { databases, account } = await createSessionClient();

    const result = await account.get();

    const user = await databases.listDocuments(
      appwriteConfig.databaseId,
      appwriteConfig.usersCollectionId,
      [Query.equal("accountId", result.$id)],
    );

    if (user.total <= 0) return null;

    return parseStringify(user.documents[0]);
  } catch (error) {
    console.log(error);
  }
};

export const signOutUser = async () => {
  const { account } = await createSessionClient();

  try {
    await account.deleteSession("current");
    (await cookies()).delete("appwrite-session");
  } catch (error) {
    handleError(error, "Failed to sign out user");
  } finally {
    redirect("/sign-in");
  }
};

export const signInUser = async ({ email }: { email: string }) => {
  try {
    const existingUser = await getUserByEmail(email);

    // User exists, send OTP
    if (existingUser) {
      await sendEmailOTP({ email });
      return parseStringify({ accountId: existingUser.accountId });
    }

    return parseStringify({ accountId: null, error: "User not found" });
  } catch (error) {
    handleError(error, "Failed to sign in user");
  }
};
