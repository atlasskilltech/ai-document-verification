const { URL } = require('url');
const dns = require('dns');
const { promisify } = require('util');

const dnsResolve = promisify(dns.resolve4);

// Private/reserved IP ranges that should be blocked
const PRIVATE_IP_RANGES = [
    /^127\./,                    // Loopback
    /^10\./,                     // Private Class A
    /^172\.(1[6-9]|2\d|3[01])\./, // Private Class B
    /^192\.168\./,               // Private Class C
    /^169\.254\./,               // Link-local
    /^0\./,                      // Current network
    /^100\.(6[4-9]|[7-9]\d|1[0-2]\d)\./, // Shared address space
    /^198\.1[89]\./,             // Benchmarking
    /^::1$/,                     // IPv6 loopback
    /^fc00:/i,                   // IPv6 unique local
    /^fe80:/i,                   // IPv6 link-local
    /^fd/i,                      // IPv6 private
];

// Blocked protocols
const ALLOWED_PROTOCOLS = ['http:', 'https:'];

function isPrivateIP(ip) {
    return PRIVATE_IP_RANGES.some(range => range.test(ip));
}

/**
 * Validates a URL to prevent SSRF attacks.
 * Checks protocol, hostname, and resolved IP addresses.
 */
async function validateUrl(fileUrl) {
    let parsed;
    try {
        parsed = new URL(fileUrl);
    } catch {
        return { valid: false, reason: 'Invalid URL format' };
    }

    // Check protocol
    if (!ALLOWED_PROTOCOLS.includes(parsed.protocol)) {
        return { valid: false, reason: `Protocol not allowed: ${parsed.protocol}. Only HTTP/HTTPS allowed.` };
    }

    // Block localhost variants
    const hostname = parsed.hostname.toLowerCase();
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '0.0.0.0') {
        return { valid: false, reason: 'Localhost URLs are not allowed' };
    }

    // Block IP addresses in private ranges
    if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) {
        if (isPrivateIP(hostname)) {
            return { valid: false, reason: 'Private IP addresses are not allowed' };
        }
    }

    // Resolve hostname and check IPs
    try {
        const addresses = await dnsResolve(hostname);
        for (const addr of addresses) {
            if (isPrivateIP(addr)) {
                return { valid: false, reason: 'URL resolves to a private IP address' };
            }
        }
    } catch (err) {
        // DNS resolution failure - could be non-resolvable or IPv6 only
        if (err.code === 'ENOTFOUND') {
            return { valid: false, reason: 'Hostname could not be resolved' };
        }
        // Allow through on other DNS errors (e.g., NODATA for IPv4 on IPv6-only hosts)
    }

    return { valid: true, url: parsed.href };
}

/**
 * Express middleware that validates file_url in request body
 */
const ssrfProtectionMiddleware = async (req, res, next) => {
    const fileUrl = req.body.file_url;
    if (!fileUrl) {
        return next(); // No URL to validate
    }

    const result = await validateUrl(fileUrl);
    if (!result.valid) {
        return res.status(400).json({
            error: 'Invalid URL',
            message: result.reason
        });
    }

    next();
};

module.exports = { validateUrl, ssrfProtectionMiddleware, isPrivateIP };
