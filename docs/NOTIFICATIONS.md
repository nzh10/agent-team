# Native notifications

Open YAAT over HTTPS. On iOS 16.4 or later, use **Add to Home Screen** and open the installed app. On Android, use Chrome. Tap the sidebar bell and allow notifications. The setting belongs to this browser installation; tap the bell again to unsubscribe it.

**# → Send test push** sends to **all subscribed devices**, including the one in front of you. “Accepted” means a push service accepted the encrypted message, not that the device displayed it. YAAT needs outbound HTTPS to the browser's public push endpoint. Notification text may appear on the device's lock screen; use the OS notification settings to hide previews.

For a real-device check on each platform:

1. Send a test with YAAT focused. Verify the OS notification appears. A normal workspace push should stay quiet with a focused, visible YAAT window on the same device.
2. Switch to another app. Have a Lead reply to a direct prompt or a worker request input. Tap the notification: the existing YAAT window should show that workspace, with any unresolved request still present.
3. Close the YAAT window and repeat. The notification should open the workspace, after login if needed. Another device's focused YAAT window should not suppress this notification.

The service stores its Web Push signing key and subscription capabilities in `push-vapid.json` and `push-subscriptions.json` under its base directory. Keep both private and back them up together. Expired endpoints are removed when their push service returns 404 or 410.
