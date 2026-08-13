import { PRIVATE_ROBOTS_DIRECTIVE } from "../metadata";

export function loader() {
  return new Response("User-agent: *\nDisallow: /\n", {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "X-Robots-Tag": PRIVATE_ROBOTS_DIRECTIVE,
    },
  });
}
