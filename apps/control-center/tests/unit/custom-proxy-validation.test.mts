import test from "node:test";
import assert from "node:assert/strict";
import {
    isBlockedProxyHostname,
    validateCustomProxyHost,
    validateCustomProxyPort,
    validateProxyLine,
} from "../../src/lib/custom-proxy-validation.ts";

// NOTE: validateCustomProxyHost performs only static, literal-value checks.
// It never resolves DNS, so it cannot detect DNS-rebinding attacks where a
// hostname that looks public resolves to a private/internal address at
// connect time. These tests exercise the static checks only.

test("validateCustomProxyHost: accepts a valid public hostname", () => {
    assert.equal(
        validateCustomProxyHost("proxy.example.com"),
        "proxy.example.com",
    );
});

test("validateCustomProxyHost: normalizes case", () => {
    assert.equal(
        validateCustomProxyHost("PROXY.EXAMPLE.COM"),
        "proxy.example.com",
    );
});

test("validateCustomProxyHost: trims surrounding whitespace", () => {
    assert.equal(
        validateCustomProxyHost("  proxy.example.com  "),
        "proxy.example.com",
    );
});

test("validateCustomProxyHost: accepts a valid public IPv4 address", () => {
    assert.equal(validateCustomProxyHost("8.8.8.8"), "8.8.8.8");
});

test("validateCustomProxyHost: rejects empty input", () => {
    assert.equal(validateCustomProxyHost(""), null);
});

test("validateCustomProxyHost: rejects whitespace-only input", () => {
    assert.equal(validateCustomProxyHost("   "), null);
});

test("validateCustomProxyHost: rejects a host longer than 253 characters", () => {
    const overlong = "a".repeat(254);
    assert.equal(validateCustomProxyHost(overlong), null);
});

test("validateCustomProxyHost: rejects a label longer than 63 characters", () => {
    const longLabel = "a".repeat(64) + ".com";
    assert.equal(validateCustomProxyHost(longLabel), null);
});

test("validateCustomProxyHost: rejects a label starting with a hyphen", () => {
    assert.equal(validateCustomProxyHost("-badstart.com"), null);
});

test("validateCustomProxyHost: rejects a label ending with a hyphen", () => {
    assert.equal(validateCustomProxyHost("bad-.com"), null);
});

test("validateCustomProxyHost: rejects a label with an underscore", () => {
    assert.equal(validateCustomProxyHost("bad_host.com"), null);
});

test("validateCustomProxyHost: rejects a host with an empty label (double dot)", () => {
    assert.equal(validateCustomProxyHost("host..com"), null);
});

test("validateCustomProxyHost: blocks the literal hostname localhost", () => {
    assert.equal(validateCustomProxyHost("localhost"), null);
});

test("validateCustomProxyHost: blocks localhost regardless of case", () => {
    assert.equal(validateCustomProxyHost("LOCALHOST"), null);
});

test("validateCustomProxyHost: blocks dot-localhost suffixes", () => {
    assert.equal(validateCustomProxyHost("foo.localhost"), null);
});

test("validateCustomProxyHost: blocks dot-local suffixes", () => {
    assert.equal(validateCustomProxyHost("myhost.local"), null);
});

test("validateCustomProxyHost: rejects single-label internal hostnames", () => {
    assert.equal(validateCustomProxyHost("local"), null);
});

test("validateCustomProxyHost: blocks IPv4 loopback 127.0.0.1", () => {
    assert.equal(validateCustomProxyHost("127.0.0.1"), null);
});

test("validateCustomProxyHost: blocks any 127 loopback address", () => {
    assert.equal(validateCustomProxyHost("127.1.2.3"), null);
});

test("validateCustomProxyHost: blocks RFC1918 private IPv4 ten range", () => {
    assert.equal(validateCustomProxyHost("10.0.0.1"), null);
});

test("validateCustomProxyHost: blocks RFC1918 private IPv4 192168 range", () => {
    assert.equal(validateCustomProxyHost("192.168.1.1"), null);
});

test("validateCustomProxyHost: blocks link local cloud metadata IPv4", () => {
    assert.equal(validateCustomProxyHost("169.254.169.254"), null);
});

test("validateCustomProxyHost: 172 15 is just below the blocked range and accepted", () => {
    assert.equal(validateCustomProxyHost("172.15.255.255"), "172.15.255.255");
});

test("validateCustomProxyHost: 172 16 is the lower boundary of the blocked range", () => {
    assert.equal(validateCustomProxyHost("172.16.0.1"), null);
});

test("validateCustomProxyHost: 172 31 is the upper boundary of the blocked range", () => {
    assert.equal(validateCustomProxyHost("172.31.255.255"), null);
});

test("validateCustomProxyHost: 172 32 is just above the blocked range and accepted", () => {
    assert.equal(validateCustomProxyHost("172.32.0.1"), "172.32.0.1");
});

test("validateCustomProxyHost: rejects malformed numeric address with out of range octets", () => {
    assert.equal(validateCustomProxyHost("999.999.999.999"), null);
});

test("validateCustomProxyHost: rejects an oversized numeric component (9999.1.1.1)", () => {
    assert.equal(validateCustomProxyHost("9999.1.1.1"), null);
});

test("validateCustomProxyHost: blocks IPv6 loopback", () => {
    assert.equal(validateCustomProxyHost("::1"), null);
});

test("validateCustomProxyHost: blocks IPv6 unspecified address", () => {
    assert.equal(validateCustomProxyHost("::"), null);
});

test("validateCustomProxyHost: blocks IPv6 link local", () => {
    assert.equal(validateCustomProxyHost("fe80::1"), null);
});

test("validateCustomProxyHost: blocks IPv6 unique local fc", () => {
    assert.equal(validateCustomProxyHost("fc00::1"), null);
});

test("validateCustomProxyHost: blocks IPv6 unique local fd", () => {
    assert.equal(validateCustomProxyHost("fd12::1"), null);
});

test("validateCustomProxyHost: rejects syntactically invalid IPv6 shaped input", () => {
    assert.equal(validateCustomProxyHost("not:a:valid:ipv6:host"), null);
});

test("validateCustomProxyHost: rejects IPv4 mapped IPv6 loopback", () => {
    assert.equal(validateCustomProxyHost("::ffff:127.0.0.1"), null);
});

test("validateCustomProxyPort: accepts the lower boundary port", () => {
    assert.equal(validateCustomProxyPort("1"), 1);
});

test("validateCustomProxyPort: accepts the upper boundary port", () => {
    assert.equal(validateCustomProxyPort("65535"), 65535);
});

test("validateCustomProxyPort: accepts a typical port", () => {
    assert.equal(validateCustomProxyPort("8080"), 8080);
});

test("validateCustomProxyPort: rejects port zero", () => {
    assert.equal(validateCustomProxyPort("0"), null);
});

test("validateCustomProxyPort: rejects a port above the maximum", () => {
    assert.equal(validateCustomProxyPort("65536"), null);
});

test("validateCustomProxyPort: rejects empty input", () => {
    assert.equal(validateCustomProxyPort(""), null);
});

test("validateCustomProxyPort: rejects a non numeric string", () => {
    assert.equal(validateCustomProxyPort("abc"), null);
});

test("validateCustomProxyPort: rejects a decimal value", () => {
    assert.equal(validateCustomProxyPort("80.5"), null);
});

test("validateCustomProxyPort: rejects a negative sign", () => {
    assert.equal(validateCustomProxyPort("-1"), null);
});

test("validateCustomProxyPort: rejects a positive sign", () => {
    assert.equal(validateCustomProxyPort("+80"), null);
});

test("validateCustomProxyPort: rejects excessively long numeric input", () => {
    assert.equal(validateCustomProxyPort("123456"), null);
    assert.equal(validateCustomProxyPort("99999999999999999999"), null);
});

test("isBlockedProxyHostname: blocks IPv4 loopback", () => {
    assert.equal(isBlockedProxyHostname("127.0.0.1"), true);
});

test("isBlockedProxyHostname: blocks RFC1918 private IPv4", () => {
    assert.equal(isBlockedProxyHostname("10.0.0.5"), true);
});

test("isBlockedProxyHostname: blocks link-local/cloud-metadata IPv4", () => {
    assert.equal(isBlockedProxyHostname("169.254.169.254"), true);
});

test("isBlockedProxyHostname: blocks IPv6 loopback", () => {
    assert.equal(isBlockedProxyHostname("::1"), true);
});

test("isBlockedProxyHostname: blocks bracketed IPv6 loopback", () => {
    assert.equal(isBlockedProxyHostname("[::1]"), true);
});

test("isBlockedProxyHostname: blocks IPv6 unique-local", () => {
    assert.equal(isBlockedProxyHostname("fd12::1"), true);
});

test("isBlockedProxyHostname: blocks IPv6 link-local", () => {
    assert.equal(isBlockedProxyHostname("fe80::1"), true);
});

test("isBlockedProxyHostname: blocks IPv4-mapped IPv6 whose embedded IPv4 is private", () => {
    assert.equal(isBlockedProxyHostname("::ffff:127.0.0.1"), true);
});

test("isBlockedProxyHostname: blocks localhost and .local suffixes", () => {
    assert.equal(isBlockedProxyHostname("localhost"), true);
    assert.equal(isBlockedProxyHostname("foo.local"), true);
});

test("isBlockedProxyHostname: does not block a valid public IPv4 address", () => {
    assert.equal(isBlockedProxyHostname("8.8.8.8"), false);
});

test("isBlockedProxyHostname: does not block a valid public hostname", () => {
    assert.equal(isBlockedProxyHostname("proxy.example.com"), false);
});

test("isBlockedProxyHostname: does not block a valid public IPv6 address", () => {
    assert.equal(isBlockedProxyHostname("2001:4860:4860::8888"), false);
});

test("isBlockedProxyHostname: does not block an IPv4-mapped IPv6 address whose embedded IPv4 is public", () => {
    assert.equal(isBlockedProxyHostname("::ffff:8.8.8.8"), false);
});

for (const host of [
    "localhost.",
    "proxy.local.",
    "proxy.localhost.",
    "postgres",
    "proxy.internal",
    "proxy.home.arpa",
    "127.1",
    "2130706433",
    "0x7f000001",
    "0x7f.0x0.0x0.0x1",
    "127.0.0.0x1",
    "0177.0.0.1",
    "127.0.0.01",
    "9999.1.1.1",
    "100.64.0.1",
    "100.127.255.255",
    "192.0.0.1",
    "192.0.2.1",
    "198.18.0.1",
    "198.19.255.255",
    "198.51.100.1",
    "203.0.113.1",
    "224.0.0.1",
    "240.0.0.1",
    "255.255.255.255",
    "[::ffff:7f00:1]",
    "::ffff:10.0.0.1",
    "::ffff:a9fe:a9fe",
    "0:0:0:0:0:0:0:1",
    "2001:db8::1",
    "ff02::1",
    "fe80::1%eth0",
    "[fe80::1%eth0]",
]) {
    test(`host validation rejects non-public or malformed host ${host}`, () => {
        assert.equal(validateCustomProxyHost(host), null);
        assert.equal(isBlockedProxyHostname(host), true);
    });
}

for (const host of [
    "proxy.example.com",
    "8.8.8.8",
    "100.63.255.255",
    "100.128.0.1",
    "198.17.255.255",
    "198.20.0.1",
    "192.0.0.9",
    "192.0.0.10",
    "2001:4860:4860::8888",
    "::ffff:8.8.8.8",
]) {
    test(`host validation accepts public host ${host}`, () => {
        assert.notEqual(validateCustomProxyHost(host), null);
        assert.equal(isBlockedProxyHostname(host), false);
    });
}

test("host validation normalizes public IPv6 and DNS root dots", () => {
    assert.equal(
        validateCustomProxyHost("[2001:4860:4860:0:0:0:0:8888]"),
        "2001:4860:4860::8888",
    );
    assert.equal(
        validateCustomProxyHost("Proxy.Example.Com."),
        "proxy.example.com",
    );
});

const acceptedLines = new Map([
    [
        "proxy.example.com:8080:alice:https://password",
        "http://alice:https%3A%2F%2Fpassword@proxy.example.com:8080",
    ],
    ["proxy.example.com:8080", "http://proxy.example.com:8080"],
    ["  proxy.example.com:8080  ", "http://proxy.example.com:8080"],
    [
        "proxy.example.com:8080:alice:part:two#%@/?",
        "http://alice:part%3Atwo%23%25%40%2F%3F@proxy.example.com:8080",
    ],
    [
        "proxy.example.com:8080:alice:part%23two",
        "http://alice:part%2523two@proxy.example.com:8080",
    ],
    [
        "[2001:4860:4860::8888]:8080:alice:password",
        "http://alice:password@[2001:4860:4860::8888]:8080",
    ],
    [
        "http://alice:p%3Aa%23s%25s@proxy.example.com:8080",
        "http://alice:p%3Aa%23s%25s@proxy.example.com:8080",
    ],
    ["http://proxy.example.com:80/", "http://proxy.example.com:80"],
    ["https://proxy.example.com:443", "https://proxy.example.com:443"],
    [
        "socks4://alice@proxy.example.com:1080",
        "socks4://alice@proxy.example.com:1080",
    ],
    [
        "socks5://alice:pass@proxy.example.com:1080",
        "socks5://alice:pass@proxy.example.com:1080",
    ],
    ["HTTP://PROXY.EXAMPLE.COM.:8080", "http://proxy.example.com:8080"],
    [
        "https://[2001:4860:4860:0:0:0:0:8888]:65535",
        "https://[2001:4860:4860::8888]:65535",
    ],
    ["http://[::ffff:8.8.8.8]:8080", "http://[::ffff:808:808]:8080"],
]);
for (const [line, expected] of acceptedLines) {
    test(`proxy line normalization accepts ${line}`, () => {
        const normalized = validateProxyLine(line);
        assert.equal(normalized, expected);
        // All persisted URLs can be fed back through the editor unchanged.
        assert.equal(validateProxyLine(normalized!), normalized);
        const parsed = new URL(normalized!);
        if (line.includes("part:two")) {
            assert.equal(decodeURIComponent(parsed.password), "part:two#%@/?");
        }
    });
}

for (const line of [
    "",
    "proxy.example.com",
    "proxy.example.com:0",
    "proxy.example.com:65536",
    "proxy.example.com:99999",
    "proxy.example.com:-1",
    "proxy.example.com:80.5",
    "999.999.999.999:8080",
    "9999.1.1.1:8080",
    "127.1:8080",
    "localhost.:8080",
    "proxy.local.:8080",
    "proxy.example.com:8080:alice:",
    "proxy.example.com:8080::password",
    "http://[::ffff:127.0.0.1]:8080",
    "https://[::ffff:10.0.0.1]:8080",
    "socks5://[::ffff:169.254.169.254]:1080",
    "socks4://[::ffff:7f00:1]:1080",
    "[::ffff:7f00:1]:8080:alice:pass",
    "http://127.1:8080",
    "http://2130706433:8080",
    "http://0x7f000001:8080",
    "http://0x7f.0x0.0x0.0x1:8080",
    "127.0.0.0x1:8080",
    "http://0177.0.0.1:8080",
    "http://localhost.:8080",
    "http://proxy.example.com:0",
    "https://proxy.example.com:65536",
    "socks5://proxy.example.com:99999",
    "ftp://proxy.example.com:21",
    "http://proxy.example.com:8080/path",
    "http://proxy.example.com:8080?query=value",
    "http://proxy.example.com:8080#fragment",
    "http://alice:part%two@proxy.example.com:8080",
    "http://alice:part#two@proxy.example.com:8080",
    "http://alice:part/two@proxy.example.com:8080",
    "http://[fe80::1%eth0]:8080",
    "http://[not:ipv6]:8080",
    "http://alice:part\\two@proxy.example.com:8080",
    "http://alice:part\ttwo@proxy.example.com:8080",
    "proxy.example.com:8080:alice:\ud800",
]) {
    test(`proxy line normalization rejects ${JSON.stringify(line)}`, () => {
        assert.equal(validateProxyLine(line), null);
    });
}
