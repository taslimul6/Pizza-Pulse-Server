import { createRemoteJWKSet, jwtVerify, errors } from "jose";
import { ObjectId } from "mongodb";

// JWT verification for the protected routes.
//
// How it works:
// 1. The Next.js app (Better Auth, "jwt" plugin) signs a short-lived JWT for the
//    logged-in user and sends it as:  Authorization: Bearer <token>
// 2. Here we check the signature against Better Auth's public keys (JWKS),
//    plus the issuer, the audience and the expiry time.
// 3. We load the user from the database, so a deleted or blocked user is
//    rejected at once even if the token itself is still valid.
//
// Env (read inside functions because of the ESM import order):
//   AUTH_URL = the address of the Next.js app, e.g. http://localhost:3000

let keys; // the public keys, downloaded once and cached by jose

function getKeys() {
  keys ??= createRemoteJWKSet(new URL("/api/auth/jwks", process.env.AUTH_URL), {
    cooldownDuration: 30_000, // do not re-download more often than this
  });
  return keys;
}

// Send the error as JSON, with the right status
function fail(res, status, error) {
  return res.status(status).json({ error });
}

// Turns a jose error into an answer for the client
function answerFor(err) {
  if (err instanceof errors.JWTExpired) {
    return [401, "Token expired. Please sign in again."];
  }
  // Could not download the public keys (the Next.js app is down)
  if (err instanceof errors.JWKSTimeout || err?.code === "ERR_JOSE_GENERIC" || err?.name === "TypeError") {
    return [503, "Cannot verify the token right now. Please try again."];
  }
  return [401, "Invalid token."];
}

// Use the users collection to build the middleware
export function createAuth(users) {
  // Checks the token and puts the user on req.user
  async function authenticate(req, res, next) {
    if (!process.env.AUTH_URL) {
      return fail(res, 500, "AUTH_URL is not set on the server");
    }

    const header = req.headers.authorization || "";
    const [scheme, token] = header.split(" ");
    if (scheme !== "Bearer" || !token) {
      return fail(res, 401, "Missing token. Send  Authorization: Bearer <token>");
    }

    let payload;
    try {
      const origin = new URL(process.env.AUTH_URL).origin;
      ({ payload } = await jwtVerify(token, getKeys(), {
        issuer: origin,
        audience: origin,
        algorithms: ["EdDSA"], // the only algorithm Better Auth signs with here
        clockTolerance: 5, // seconds
      }));
    } catch (err) {
      const [status, message] = answerFor(err);
      return fail(res, status, message);
    }

    // The token is valid. Now check the user is still allowed in.
    if (typeof payload.sub !== "string" || !ObjectId.isValid(payload.sub)) {
      return fail(res, 401, "Invalid token.");
    }
    const user = await users.findOne({ _id: new ObjectId(payload.sub) });
    if (!user) {
      return fail(res, 401, "User not found.");
    }
    if (user.isBlocked === true) {
      return fail(res, 403, "Your account has been blocked.");
    }

    req.user = user; // the role comes from the database, not from the token
    next();
  }

  // Use after authenticate:  requireRole("vendor")  or  requireRole("admin", "vendor")
  function requireRole(...roles) {
    return (req, res, next) => {
      if (!roles.includes(req.user?.role)) {
        return fail(res, 403, `Only ${roles.join(" or ")} can do this.`);
      }
      next();
    };
  }

  return { authenticate, requireRole };
}
