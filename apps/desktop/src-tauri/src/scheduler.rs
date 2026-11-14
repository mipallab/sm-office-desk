use std::time::{Duration, Instant};

use rand::Rng;

pub const RANDOM_CAPTURE_MIN_SECONDS: u64 = 600;
pub const RANDOM_CAPTURE_MAX_SECONDS: u64 = 1800;
pub const HEARTBEAT_INTERVAL_SECONDS: u64 = 60;

/// Picks a uniformly randomized interval in [600s, 1800s] (10 to 30 minutes).
pub fn next_random_interval_secs() -> u64 {
    let mut rng = rand::thread_rng();
    rng.gen_range(RANDOM_CAPTURE_MIN_SECONDS..=RANDOM_CAPTURE_MAX_SECONDS)
}

/// Monotonic random capture scheduler anchored strictly to `std::time::Instant`.
/// Completely immune to system wall-clock jumps or manual date/time tampering.
#[derive(Debug, Clone)]
pub struct MonotonicCaptureScheduler {
    started_at: Instant,
    next_capture_at: Instant,
    last_interval_seconds: u64,
}

impl MonotonicCaptureScheduler {
    pub fn start(now: Instant) -> Self {
        let interval = next_random_interval_secs();
        Self {
            started_at: now,
            next_capture_at: now + Duration::from_secs(interval),
            last_interval_seconds: interval,
        }
    }

    pub fn is_due(&self, now: Instant) -> bool {
        now >= self.next_capture_at
    }

    pub fn schedule_next(&mut self, now: Instant) -> u64 {
        let interval = next_random_interval_secs();
        self.last_interval_seconds = interval;
        self.next_capture_at = now + Duration::from_secs(interval);
        interval
    }

    pub fn monotonic_elapsed_ms(&self, now: Instant) -> u64 {
        now.saturating_duration_since(self.started_at).as_millis() as u64
    }

    pub fn next_capture_at(&self) -> Instant {
        self.next_capture_at
    }

    pub fn last_interval_seconds(&self) -> u64 {
        self.last_interval_seconds
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn random_intervals_always_within_10_to_30_minutes() {
        for _ in 0..2000 {
            let secs = next_random_interval_secs();
            assert!(
                (RANDOM_CAPTURE_MIN_SECONDS..=RANDOM_CAPTURE_MAX_SECONDS).contains(&secs),
                "interval {secs} outside 600..=1800"
            );
        }
    }

    #[test]
    fn monotonic_scheduler_triggers_at_or_after_scheduled_instant() {
        let t0 = Instant::now();
        let mut sched = MonotonicCaptureScheduler::start(t0);
        let first_interval = sched.last_interval_seconds();
        assert!((600..=1800).contains(&first_interval));
        assert!(!sched.is_due(t0 + Duration::from_secs(first_interval - 1)));
        assert!(sched.is_due(t0 + Duration::from_secs(first_interval)));

        let t1 = t0 + Duration::from_secs(first_interval);
        let next_interval = sched.schedule_next(t1);
        assert!((600..=1800).contains(&next_interval));
        assert_eq!(
            sched.next_capture_at(),
            t1 + Duration::from_secs(next_interval)
        );
    }
}
