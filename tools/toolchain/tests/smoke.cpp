// Exercises the parts of the WASI host the playground depends on: stdio,
// stdin, the in-memory filesystem, and exceptions.
#include <algorithm>
#include <fstream>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

int main() {
    std::string name;
    std::getline(std::cin, name);
    std::cout << "hello, " << (name.empty() ? "world" : name) << "\n";

    std::vector<int> v{5, 3, 9, 1};
    std::sort(v.begin(), v.end());
    for (int x : v) std::cout << x << ' ';
    std::cout << '\n';

    {
        std::ofstream out("/work/probe.txt");
        out << "file io works\n";
    }
    std::ifstream in("/work/probe.txt");
    std::string line;
    std::getline(in, line);
    std::cout << line << '\n';

    try {
        throw std::runtime_error("boom");
    } catch (const std::exception& e) {
        std::cout << "caught: " << e.what() << '\n';
    }

    std::cerr << "stderr works\n";
    return 0;
}
