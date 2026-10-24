const std = @import("std");

export fn phonon_sha256(data: [*]const u8, len: usize, out: *[32]u8) callconv(.C) void {
    std.crypto.hash.sha2.Sha256.hash(data[0..len], out, .{});
}

export fn phonon_utf8_valid(data: [*]const u8, len: usize) callconv(.C) bool {
    return std.unicode.utf8ValidateSlice(data[0..len]);
}
