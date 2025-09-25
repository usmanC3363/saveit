"use server";

import { createAdminClient, createSessionClient } from "@/lib/appwrite";
import { InputFile } from "node-appwrite/file";
import { appwriteConfig } from "@/lib/appwrite/config";
import { ID, Query } from "node-appwrite";
import { constructFileUrl, getFileType, parseStringify } from "@/lib/utils";
import { revalidatePath } from "next/cache";
import { getCurrentUser } from "@/lib/actions/user.actions";
import {
  DeleteFileProps,
  FileType,
  GetFilesProps,
  RenameFileProps,
  UpdateFileUsersProps,
  UploadFileProps,
  UserDocument,
} from "../../../types";

const handleError = (error: unknown, message: string) => {
  console.log(error, message);
  throw error;
};

export const uploadFile = async ({
  file,
  ownerId,
  accountId,
  path,
}: UploadFileProps) => {
  const { storage, databases } = await createAdminClient();

  try {
    // coming from node-appwrite
    const inputFile = InputFile.fromBuffer(file, file.name);

    const bucketFile = await storage.createFile(
      appwriteConfig.bucketId,
      ID.unique(),
      inputFile,
      // [Permission.read(Role.any())], // <- allow public read
    );

    // inside uploadFile (replace the part after bucketFile assignment)
    const attrsResp = await databases.listAttributes(
      appwriteConfig.databaseId,
      appwriteConfig.filesCollectionId,
    );

    // normalize attribute list (older SDK shapes vary)
    const attrsArray = Array.isArray(attrsResp.attributes)
      ? attrsResp.attributes
      : Array.isArray(attrsResp)
        ? attrsResp
        : [];

    // Build a set of existing attribute keys (case-sensitive)
    const existingKeys = new Set<string>(
      attrsArray.map((a: any) => a.key ?? a.$id).filter(Boolean),
    );

    // Helper to pick the correct key from a list of candidates
    const pickKey = (...candidates: string[]) => {
      for (const k of candidates) {
        if (existingKeys.has(k)) return k;
      }
      return null;
    };

    // Map known field variants to values only when the attribute exists
    const fileDocument: Record<string, any> = {};

    // always include fields that are almost surely present: name/url/type/size/extension/owner/users
    if (pickKey("name")) fileDocument.name = bucketFile.name;
    if (pickKey("url")) fileDocument.url = constructFileUrl(bucketFile.$id);
    if (pickKey("type")) fileDocument.type = getFileType(bucketFile.name).type;
    if (pickKey("extension"))
      fileDocument.extension = getFileType(bucketFile.name).extension;
    if (pickKey("size")) fileDocument.size = bucketFile.sizeOriginal;
    if (pickKey("owner")) fileDocument.owner = ownerId;

    // account id is tricky: collection might expect "accountID" or "accountId"
    const accountKey = pickKey("accountID", "accountId", "account_id");
    if (accountKey) fileDocument[accountKey] = accountId;

    // bucket/file reference variations
    const bucketFileKey = pickKey(
      "bucketFileId",
      "bucket_file_id",
      "bucketFile",
      "bucket_file",
      "bucketField",
    );
    if (bucketFileKey) fileDocument[bucketFileKey] = bucketFile.$id;

    // users array
    if (pickKey("users")) fileDocument.users = [];

    // If some keys you expect are missing, we still include the most essential ones (name + url) above.
    // Attempt to create the document
    const newFile = await databases
      .createDocument(
        appwriteConfig.databaseId,
        appwriteConfig.filesCollectionId,
        ID.unique(),
        fileDocument,
      )
      .catch(async (error: unknown) => {
        await storage.deleteFile(appwriteConfig.bucketId, bucketFile.$id);
        handleError(error, "Failed to create file document");
      });

    revalidatePath(path);
    return parseStringify(newFile);
  } catch (error) {
    handleError(error, "Failed to upload file");
  }
};

// ------------------- replace createQueries with this -------------------
const createQueries = (
  currentUser: UserDocument,
  types: string[],
  searchText: string,
  sort: string,
  limit?: number,
) => {
  // Build the OR clause: owner equals current user's doc id OR users array contains the user's email (if present)
  const orClauses = [Query.equal("owner", [currentUser.$id])];
  if (currentUser.email) {
    orClauses.push(Query.contains("users", [currentUser.email]));
  }

  const queries: any[] = [Query.or(orClauses)];
  // type filtering
  if (types.length > 0) queries.push(Query.equal("type", types));

  if (searchText) queries.push(Query.contains("name", searchText));
  if (limit) queries.push(Query.limit(limit));

  if (sort) {
    const [sortBy, orderBy] = sort.split("-");
    queries.push(
      orderBy === "asc" ? Query.orderAsc(sortBy) : Query.orderDesc(sortBy),
    );
  }

  return queries;
};

// ------------------- replace getFiles with this -------------------
export const getFiles = async ({
  types = [],
  searchText = "",
  sort = "$createdAt-desc",
  limit,
}: GetFilesProps) => {
  const { databases } = await createAdminClient();

  try {
    const currentUser = await getCurrentUser();

    if (!currentUser) throw new Error("User not found");

    const queries = createQueries(currentUser, types, searchText, sort, limit);

    const filesResp = await databases.listDocuments(
      appwriteConfig.databaseId,
      appwriteConfig.filesCollectionId,
      queries,
    );

    const files = Array.isArray(filesResp.documents) ? filesResp.documents : [];

    // Collect unique owner ids (owner can be a string id or an object)
    const ownerIds = Array.from(
      new Set(
        files
          .map((f: any) => {
            if (!f) return null;
            if (typeof f.owner === "string") return f.owner;
            if (typeof f.owner === "object" && f.owner !== null)
              return f.owner.$id ?? null;
            return null;
          })
          .filter(Boolean),
      ),
    );

    // Map ownerId -> user document
    const ownerMap: Record<string, any> = {};

    await Promise.all(
      ownerIds.map(async (ownerId) => {
        try {
          // try getting by document id first
          const userDoc = await databases.getDocument(
            appwriteConfig.databaseId,
            appwriteConfig.usersCollectionId,
            ownerId,
          );
          ownerMap[ownerId] = userDoc;
        } catch (err) {
          // fallback: try finding by accountId
          try {
            const byAccount = await databases.listDocuments(
              appwriteConfig.databaseId,
              appwriteConfig.usersCollectionId,
              [Query.equal("accountId", [ownerId]), Query.limit(1)],
            );
            if (byAccount.total > 0) {
              ownerMap[ownerId] = byAccount.documents[0];
              return;
            }
            // fallback: try email match
            const byEmail = await databases.listDocuments(
              appwriteConfig.databaseId,
              appwriteConfig.usersCollectionId,
              [Query.equal("email", [ownerId]), Query.limit(1)],
            );
            if (byEmail.total > 0) {
              ownerMap[ownerId] = byEmail.documents[0];
            }
          } catch (err2) {
            // ignore - ownerMap[ownerId] stays undefined
          }
        }
      }),
    );

    // Attach resolved owner object (if found) to each file doc
    const filesWithOwners = files.map((f: any) => {
      const ownerIdValue =
        typeof f.owner === "string" ? f.owner : (f.owner?.$id ?? null);
      const resolvedOwner = ownerIdValue ? ownerMap[ownerIdValue] : null;
      return {
        ...f,
        owner: resolvedOwner ?? f.owner, // if resolved use full doc, otherwise keep original (string or object)
      };
    });

    // Return same structure as Appwrite but with documents replaced
    const out = { ...filesResp, documents: filesWithOwners };
    return parseStringify(out);
  } catch (error) {
    handleError(error, "Failed to get files");
  }
};

export const renameFile = async ({
  fileId,
  name,
  extension,
  path,
}: RenameFileProps) => {
  const { databases } = await createAdminClient();

  try {
    const newName = `${name}.${extension}`;
    const updatedFile = await databases.updateDocument(
      appwriteConfig.databaseId,
      appwriteConfig.filesCollectionId,
      fileId,
      {
        name: newName,
      },
    );

    revalidatePath(path);
    return parseStringify(updatedFile);
  } catch (error) {
    handleError(error, "Failed to rename file");
  }
};

export const updateFileUsers = async ({
  fileId,
  emails,
  path,
}: UpdateFileUsersProps) => {
  const { databases } = await createAdminClient();

  try {
    const updatedFile = await databases.updateDocument(
      appwriteConfig.databaseId,
      appwriteConfig.filesCollectionId,
      fileId,
      {
        users: emails,
      },
    );

    revalidatePath(path);
    return parseStringify(updatedFile);
  } catch (error) {
    handleError(error, "Failed to rename file");
  }
};

export const deleteFile = async ({
  fileId,
  bucketFileId,
  path,
}: DeleteFileProps) => {
  const { databases, storage } = await createAdminClient();

  try {
    const deletedFile = await databases.deleteDocument(
      appwriteConfig.databaseId,
      appwriteConfig.filesCollectionId,
      fileId,
    );

    if (deletedFile) {
      await storage.deleteFile(appwriteConfig.bucketId, bucketFileId);
    }

    revalidatePath(path);
    return parseStringify({ status: "success" });
  } catch (error) {
    handleError(error, "Failed to rename file");
  }
};

// ============================== TOTAL FILE SPACE USED
export async function getTotalSpaceUsed() {
  try {
    const { databases } = await createSessionClient();
    const currentUser = await getCurrentUser();
    if (!currentUser) throw new Error("User is not authenticated.");

    const files = await databases.listDocuments(
      appwriteConfig.databaseId,
      appwriteConfig.filesCollectionId,
      [Query.equal("owner", [currentUser.$id])],
    );

    const totalSpace = {
      image: { size: 0, latestDate: "" },
      document: { size: 0, latestDate: "" },
      video: { size: 0, latestDate: "" },
      audio: { size: 0, latestDate: "" },
      other: { size: 0, latestDate: "" },
      used: 0,
      all: 2 * 1024 * 1024 * 1024 /* 2GB available bucket storage */,
    };

    files.documents.forEach((file) => {
      const fileType = file.type as FileType;
      totalSpace[fileType].size += file.size;
      totalSpace.used += file.size;

      if (
        !totalSpace[fileType].latestDate ||
        new Date(file.$updatedAt) > new Date(totalSpace[fileType].latestDate)
      ) {
        totalSpace[fileType].latestDate = file.$updatedAt;
      }
    });

    return parseStringify(totalSpace);
  } catch (error) {
    handleError(error, "Error calculating total space used:, ");
  }
}
