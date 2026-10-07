# Security policy

Hookd runs entirely in the browser. It has no server, accounts or database, and songs never leave the user's device.

## Reporting a problem

Please don't open a public issue for security problems. Instead, use GitHub's private reporting: go to the repo's **Security** tab and choose **Report a vulnerability**.

Useful things to include: what you found, the steps to reproduce it, and which browser you used.

## In scope

- The site at https://hookd-sage.vercel.app and the code in this repo
- Ways a page, file or link could run code or read data it shouldn't

The third-party libraries (lamejs, mp4-muxer, webm-muxer) are pinned to exact versions with integrity hashes. Problems inside them are best reported to their own projects.
