"""Isolate the atomic capture receipt and browser restart contract from the broader assistant journey."""
from agent_capture_preview_e2e import main

if __name__ == '__main__':
    main(receipt_only=True)
