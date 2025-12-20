from playwright.sync_api import sync_playwright, Page, expect

def verify_webgpu_page(page: Page):
    # Navigate to the page
    page.goto("http://localhost:8000/webgpu-demo.html")

    # Wait for the status element to appear
    status_locator = page.locator("#status")
    expect(status_locator).to_be_visible()

    # Capture the initial state or error state
    # Since WebGPU might not be available in headless, we expect it might show an error or just initialize.
    # We will wait a bit to see if text updates.
    page.wait_for_timeout(2000)

    # Take screenshot
    page.screenshot(path="verification/webgpu_verification.png")

    # Print the status text for debugging
    print(f"Status Text: {status_locator.inner_text()}")

if __name__ == "__main__":
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()
        try:
            verify_webgpu_page(page)
        except Exception as e:
            print(f"Verification failed: {e}")
        finally:
            browser.close()
