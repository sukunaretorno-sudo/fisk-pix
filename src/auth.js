const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET.length < 24 || JWT_SECRET.startsWith('TROQUE_')) {
  throw new Error('Defina JWT_SECRET com pelo menos 24 caracteres no .env ou Render > Environment.');
}
const JWT_EXPIRES_IN = '7d';

/**
 * Hash password using Node's native scrypt with a random 16-byte salt
 */
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derivedKey = crypto.scryptSync(password, salt, 64);
  return `${salt}:${derivedKey.toString('hex')}`;
}

/**
 * Verify a password against a stored salt:hash string
 */
function verifyPassword(password, stored) {
  if (typeof password !== 'string' || !stored || !stored.includes(':')) return false;
  const [salt, key] = stored.split(':');
  const keyBuffer = Buffer.from(key, 'hex');
  if (keyBuffer.length !== 64) return false;
  const derivedKey = crypto.scryptSync(password, salt, 64);
  return crypto.timingSafeEqual(keyBuffer, derivedKey);
}

/**
 * Generate a signed JWT token
 */
function generateToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

/**
 * Express middleware to verify JWT
 */
async function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.startsWith('Bearer ') 
    ? authHeader.slice(7) 
    : req.query.token;

  if (!token) {
    return res.status(401).json({ error: 'Acesso não autorizado. Faça login novamente.' });
  }

  let decoded;
  try { decoded = jwt.verify(token, JWT_SECRET); }
  catch { return res.status(401).json({ error: 'Sessão inválida ou expirada. Faça login novamente.' }); }
  try {
    // Lazy import avoids the password-hashing dependency cycle during startup.
    const user = await require('./db').getUserById(decoded.id);
    if (!user || !user.is_active || Number(decoded.token_version || 0) !== Number(user.token_version)) {
      return res.status(401).json({ error: 'Seu acesso foi atualizado. Faça login novamente ou procure a coordenação.' });
    }
    req.user = user;
    next();
  } catch (err) { next(err); }
}

/**
 * Middleware to restrict route to specific roles
 */
function requireRoles(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user || !allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Permissão negada para esta operação.' });
    }
    next();
  };
}

module.exports = {
  hashPassword,
  verifyPassword,
  generateToken,
  authenticateToken,
  requireRoles
};
