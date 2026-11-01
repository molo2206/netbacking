// apps/auth-service/src/utility/helpers/login-attempt.util.ts
import { PrismaClient } from '@prisma/client';
import * as crypto from 'crypto';

export async function logFailedLoginAttempt(
  prisma: PrismaClient,
  userId: string | null,
  identifier: string,
  ipAddress: string | null,
  userAgent: string | undefined,
  failedAttempts?: number,
  lockedUntil?: Date | null,
): Promise<void> {
  try {
    // ✅ login_attempt → login_attempt (vérifier le nom exact dans Prisma)
    await prisma.login_attempt.create({
      data: {
        id: crypto.randomUUID(),
        userId: userId,
        identifier: identifier,
        success: false,
        ipAddress: ipAddress,
        userAgent: userAgent || null,
        createdAt: new Date(),
        failed_pin_attempts: failedAttempts || 0,
        pin_locked_until: lockedUntil || null,
      },
    });
  } catch (err) {
    console.error('Failed to log login attempt:', err);
  }
}