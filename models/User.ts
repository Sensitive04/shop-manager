import { Schema, type InferSchemaType } from 'mongoose';

import { modelFrom } from '@/lib/model';

/**
 * The single shop owner account.
 *
 * Roles are deliberately absent. There is one user today, so a `role` field
 * would be a value nothing branches on yet — and an unbranched field is worse
 * than none, because the next person assumes it enforces something. The schema
 * is the place to add it if staff accounts ever appear.
 *
 * SECURITY: this schema holds credential material. `passwordHash` is a scrypt
 * digest (salt + params + key, colon-separated) and never the plaintext, and
 * `sessionTokens` stores hashes only — a database leak therefore does not hand
 * an attacker either the password or a usable session cookie.
 */

const sessionTokenSchema = new Schema(
  {
    /**
     * scrypt digest of the raw cookie token, never the token itself. Compare
     * against a stolen database dump and an attacker has nothing to replay.
     */
    tokenHash: { type: String, required: true },
    createdAt: { type: Date, default: () => new Date(), required: true },
    expiresAt: { type: Date, required: true },
  },
  { _id: false },
);

const userSchema = new Schema(
  {
    /** Lower-cased and trimmed on write; unique so the login form can match on it. */
    username: {
      type: String,
      required: [true, 'Username is required'],
      trim: true,
      lowercase: true,
      minlength: [3, 'Username must be at least 3 characters'],
      maxlength: [40, 'Username must be 40 characters or fewer'],
    },

    /**
     * scrypt output, never a plaintext password. `select: false` keeps it out of
     * ordinary queries, so an accidental `User.findOne()` cannot leak it into a
     * response — `verifyPassword` opts back in explicitly.
     */
    passwordHash: { type: String, required: true, select: false },

    /** Shown in the nav bar; defaults to the username when not set. */
    displayName: { type: String, trim: true, maxlength: [80, 'Display name is too long'] },

    lastLoginAt: { type: Date },

    sessionTokens: { type: [sessionTokenSchema], default: [] },
  },
  { timestamps: true },
);

userSchema.index({ username: 1 }, { unique: true });
// Supports the expired-session sweep without a collection scan.
userSchema.index({ 'sessionTokens.expiresAt': 1 });

export type UserShape = InferSchemaType<typeof userSchema>;

export const User = modelFrom<UserShape>('User', userSchema);