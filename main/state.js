const EventEmitter = require('events');

const States = {
    IDLE: 'IDLE',
    ARMED: 'ARMED',
    RECORDING: 'RECORDING',
    FINALIZING: 'FINALIZING'
};

class StateMachine extends EventEmitter {
    constructor() {
        super();
        this.currentState = States.IDLE;
        this.armTimer = null;
        this.otherKeyPressed = false;
        this.ctrlKeyDown = false;
        this.ARM_THRESHOLD = 1200; // 1.2 seconds - Long press to trigger
    }

    isCtrl(keycode) {
        return keycode === 29 || keycode === 3613;
    }

    handleKeyDown(keycode) {
        const isCtrlKey = this.isCtrl(keycode);

        if (isCtrlKey) {
            // Only trigger if we are transitioning from IDLE to ARMED
            // This prevents key-repeat from constantly resetting the timer
            if (this.currentState !== States.IDLE) return;

            this.ctrlKeyDown = true;
            this.otherKeyPressed = false;

            this.currentState = States.ARMED;
            this.emit('stateChanged', this.currentState);

            this.armTimer = setTimeout(() => {
                // Final verification before moving to RECORDING
                if (
                    this.currentState === States.ARMED &&
                    this.ctrlKeyDown &&
                    !this.otherKeyPressed
                ) {
                    this.currentState = States.RECORDING;
                    this.emit('stateChanged', this.currentState);
                    this.emit('startRecording');
                }
            }, this.ARM_THRESHOLD);
            return;
        }

        // Any other key while Ctrl is held = shortcut detected → cancel potential dictation
        if (this.ctrlKeyDown) {
            this.otherKeyPressed = true;

            // Snap back to IDLE immediately if we were in the arming window
            if (this.currentState === States.ARMED) {
                console.log('Shortcut detected during ARM window - cancelling dictation');
                this.reset();
            }
        }
    }

    handleKeyUp(keycode) {
        const isCtrlKey = this.isCtrl(keycode);

        // We only transition state states on the release of the Control key
        if (!isCtrlKey) return;

        this.ctrlKeyDown = false;

        if (this.currentState === States.ARMED) {
            // Released early: release timer and go back to IDLE
            this.reset();
        } else if (this.currentState === States.RECORDING) {
            // Normal dictation stop: transition to FINALIZING
            this.currentState = States.FINALIZING;
            this.emit('stateChanged', this.currentState);
            this.emit('stopRecording');
        }
    }

    reset() {
        if (this.armTimer) {
            clearTimeout(this.armTimer);
            this.armTimer = null;
        }
        this.otherKeyPressed = false;
        this.ctrlKeyDown = false; // Reset tracking flag as well
        this.currentState = States.IDLE;
        this.emit('stateChanged', this.currentState);
    }
}

module.exports = { StateMachine, States };
