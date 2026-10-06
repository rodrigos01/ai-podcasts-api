/**
 * Wraps a write function so the first `skipBytes` bytes passed through it are
 * dropped. Used to honor `Range: bytes=N-` on a response whose byte space is
 * "this URL's own stream" (i.e. already offset by `?t=`), including the live
 * path where the bytes aren't all known up front.
 */
export function createByteSkipper(
  skipBytes: number,
  write: (data: Buffer) => void,
): (data: Buffer) => void {
  let remaining = Math.max(0, skipBytes);
  return (data: Buffer) => {
    if (remaining === 0) {
      if (data.length > 0) write(data);
      return;
    }
    if (data.length <= remaining) {
      remaining -= data.length;
      return;
    }
    const rest = data.subarray(remaining);
    remaining = 0;
    write(rest);
  };
}
