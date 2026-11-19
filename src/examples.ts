export const examples = [
  {
    id: 'references', title: '객체와 참조', hint: '대입하면 객체가 복제될까요? 두 화살표가 어디로 향하는지 확인해 보세요.',
    code: `class Student {
    String name;
    int score;

    Student(String name, int score) {
        this.name = name;
        this.score = score;
    }
}

public class Main {
    public static void main(String[] args) {
        int bonus = 5;
        Student alice = new Student("Alice", 90);

        // 객체가 아니라 참조가 복사돼요.
        Student friend = alice;
        friend.score += bonus;

        System.out.println(alice.score); // 95
    }
}`,
  },
  {
    id: 'stack', title: '메서드와 스택', hint: '호출할 때마다 새 프레임이 쌓이고, 메서드가 끝나면 그 프레임의 지역 변수가 사라져요.',
    code: `public class Main {
    static int twice(int value) {
        int result = value * 2;
        return result;
    }

    static int addBonus(int score) {
        int bonus = twice(5);
        return score + bonus;
    }

    public static void main(String[] args) {
        int original = 80;
        int total = addBonus(original);
        System.out.println(total);
    }
}`,
  },
  {
    id: 'arrays', title: '배열과 값 복사', hint: '기본형은 값 자체를 복사하지만, 배열을 대입하면 같은 배열을 가리키게 돼요.',
    code: `public class Main {
    public static void main(String[] args) {
        int original = 10;
        int copy = original;
        copy = 99;

        int[] scores = {78, 90, 88};
        int[] sameArray = scores;
        sameArray[0] = 100;

        System.out.println(original);  // 10
        System.out.println(scores[0]); // 100
    }
}`,
  },
  {
    id: 'static', title: '클래스와 static', hint: '인스턴스마다 따로 있는 필드와, 모든 인스턴스가 공유하는 static 필드를 비교해 보세요.',
    code: `class Ticket {
    static int issued = 0;
    int number;

    Ticket() {
        issued++;
        number = issued;
    }
}

public class Main {
    public static void main(String[] args) {
        Ticket first = new Ticket();
        Ticket second = new Ticket();
        System.out.println(first.number);
        System.out.println(second.number);
        System.out.println(Ticket.issued);
    }
}`,
  },
  {
    id: 'gc', title: '참조 해제와 GC', hint: '객체를 가리키는 마지막 연결이 사라지면, 그 객체는 가비지 컬렉션의 후보가 돼요.',
    code: `class Box {
    int value;
}

public class Main {
    public static void main(String[] args) {
        Box first = new Box();
        first.value = 42;
        Box second = first;

        first = null;  // second가 여전히 참조해요.
        second = null; // 가리키는 변수가 없어요.
        System.out.println("done");
    }
}`,
  },
];
