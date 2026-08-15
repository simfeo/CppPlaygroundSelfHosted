// Exercises the threading features a playground user would reach for.
#include <atomic>
#include <iostream>
#include <mutex>
#include <thread>
#include <vector>

int main() {
    std::atomic<int> total{0};
    std::mutex io;
    std::vector<std::thread> workers;

    for (int i = 0; i < 4; ++i) {
        workers.emplace_back([i, &total, &io] {
            int sum = 0;
            for (int n = 0; n < 1000; ++n) sum += n * (i + 1);
            total += sum;
            std::lock_guard<std::mutex> lock(io);
            std::cout << "worker " << i << " summed " << sum << '\n';
        });
    }
    for (auto& t : workers) t.join();

    std::cout << "hardware_concurrency=" << std::thread::hardware_concurrency() << '\n';
    std::cout << "total=" << total.load() << '\n';
}
