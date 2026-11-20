import { examples } from './examples';

export const languages = {
  java: { name: 'Java', path: '/', example: examples[0].code },
  csharp: { name: 'C#', path: '/csharp', example: `class Student
{
    public string Name;
    public int Score;

    public Student(string name, int score)
    {
        Name = name;
        Score = score;
    }
}

class Program
{
    static void Main()
    {
        int bonus = 5;
        Student alice = new Student("Alice", 90);
        Student friend = alice;

        // 두 변수가 같은 객체를 가리켜요.
        friend.Score += bonus;
        Console.WriteLine(alice.Score); // 95
    }
}` },
  python: { name: 'Python', path: '/python', example: `class Student:
    def __init__(self, name, score):
        self.name = name
        self.score = score


def main():
    bonus = 5
    alice = Student("Alice", 90)
    friend = alice

    # 두 이름이 같은 객체를 가리켜요.
    friend.score += bonus
    print(alice.score)  # 95


main()` },
  rust: { name: 'Rust', path: '/rust', example: `struct Student {
    score: i32,
}

fn add_bonus(student: &mut Student, bonus: i32) {
    student.score += bonus;
}

fn main() {
    let mut alice = Student { score: 90 };
    let before = alice.score; // i32 값 복사
    let borrowed = &mut alice; // alice를 가변으로 빌려요.
    add_bonus(borrowed, 5);
    println!("{} → {}", before, alice.score); // 90 → 95
}` },
} as const;

export type Language = keyof typeof languages;
